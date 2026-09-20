/**
 * `core/scheduler.ts`'s shutdown ordering: once `stop()` has begun, neither the `newJob` NOTIFY
 * handler nor the polling interval may claim a job, and a claim already under way is waited for
 * before the worker pool is destroyed. Pure — no database.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, afterEach, describe, test } from 'node:test'
import { ensureTemporal } from '../test/temporal.ts'
import { installTestWiki } from '../test/mocks.ts'
import { createDeferred } from '../helpers/common.ts'

let scheduler: any

before(async () => {
  await ensureTemporal()
  scheduler = (await import('./scheduler.ts')).default
})

describe('stop() and job claiming (fake CARDINAL)', () => {
  let wikiHandle: { restore(): void }
  let claimCalls: number
  let events: string[]
  let notificationHandler: ((msg: any) => Promise<void>) | null
  let claimGate: Promise<void> | null

  beforeEach(() => {
    claimCalls = 0
    events = []
    notificationHandler = null
    claimGate = null

    const fakeClient = {
      on: (event: string, handler: any) => {
        if (event === 'notification') {
          notificationHandler = handler
        }
      },
      query: async () => ({}),
      release: () => {}
    }

    wikiHandle = installTestWiki({
      INSTANCE_ID: 'test-instance',
      config: {
        scheduler: { taskTimeout: 0.05, scheduledCheck: 1_000_000, pollingCheck: 1_000_000 }
      },
      dbManager: { listenerPool: { connect: async () => fakeClient } },
      db: {
        transaction: async () => {
          claimCalls++
          if (claimGate) {
            await claimGate
          }
          events.push('claim-done')
          return []
        }
      }
    })
    scheduler.maxWorkers = 1
    scheduler.activeWorkers = 0
    scheduler.stopping = false
    scheduler.inFlightJobs = new Set()
    scheduler.pollingRef = null
    scheduler.scheduledRef = null
    scheduler.listenerHandle = null
    scheduler.addScheduled = async () => 0
    scheduler.reapStaleJobs = async () => []
    scheduler.workerPool = {
      destroy: async () => {
        events.push('destroy')
      }
    }
  })

  afterEach(() => {
    clearInterval(scheduler.pollingRef)
    clearInterval(scheduler.scheduledRef)
    scheduler.pollingRef = null
    scheduler.scheduledRef = null
  })

  after(() => {
    wikiHandle.restore()
    scheduler.workerPool = null
    scheduler.listenerHandle = null
    scheduler.stopping = false
    scheduler.inFlightJobs = new Set()
    delete scheduler.addScheduled
    delete scheduler.reapStaleJobs
  })

  test('a newJob notification arriving after stop() begins claims nothing', async () => {
    await scheduler.start()
    assert.ok(notificationHandler, 'test setup sanity check: start() registered a handler')

    const held = createDeferred<void>()
    scheduler.inFlightJobs.add(held.promise)
    const stopPromise = scheduler.stop()

    await notificationHandler!({
      channel: 'scheduler',
      payload: JSON.stringify({ event: 'newJob' })
    })

    assert.equal(claimCalls, 0, 'the NOTIFY handler must not claim once stop() has begun')
    assert.equal(scheduler.activeWorkers, 0, 'nothing may be reserved either')

    held.resolve()
    await stopPromise
    assert.deepEqual(events, ['destroy'])
  })

  test('a polling processJob() after stop() begins claims nothing', async () => {
    const held = createDeferred<void>()
    scheduler.inFlightJobs.add(held.promise)
    const stopPromise = scheduler.stop()

    await scheduler.processJob()

    assert.equal(claimCalls, 0)
    assert.equal(scheduler.activeWorkers, 0)

    held.resolve()
    await stopPromise
  })

  test('a claim already under way when stop() begins is awaited before the pool is destroyed', async () => {
    const gate = createDeferred<void>()
    claimGate = gate.promise

    const claiming = scheduler.processJob()
    assert.equal(claimCalls, 1, 'test setup sanity check: the claim has started')

    const stopPromise = scheduler.stop()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(events, [], 'the pool must not be destroyed under a claim in progress')

    gate.resolve()
    await claiming
    await stopPromise

    assert.deepEqual(events, ['claim-done', 'destroy'])
  })

  test('start() after a stop() lets processJob() claim again', async () => {
    await scheduler.stop()
    await scheduler.processJob()
    assert.equal(claimCalls, 0, 'test setup sanity check: stopped')

    await scheduler.start()
    await scheduler.processJob()

    assert.equal(claimCalls, 1)
  })
})
