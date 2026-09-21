/**
 * `core/scheduler.ts`'s job bookkeeping: queueing (`addScheduled`, `addJob`), the completion-promise
 * map, and shutdown. Pure — no database, no worker pool.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { jobs as jobsTable, jobSchedule as jobScheduleTable } from '../db/schema.ts'
import { ensureTemporal } from '../test/temporal.ts'
import { installTestWiki } from '../test/mocks.ts'

let scheduler: any

before(async () => {
  await ensureTemporal()
  scheduler = (await import('./scheduler.ts')).default
})

describe('addScheduled (fake CARDINAL)', () => {
  let insertedJobs: any[]
  let scheduleJobsMock: any[]
  let existingJobsMock: any[]
  let wikiHandle: { restore(): void }

  let insertShouldFail: boolean

  before(() => {
    // -> `addScheduled()` reads both selects through its own transaction (`trx`), so the fake `trx`
    //    exposes `select()` too.
    const selectImpl = () => ({
      from: (table: any) => {
        if (table === jobScheduleTable) {
          return scheduleJobsMock
        }
        if (table === jobsTable) {
          return { where: async () => existingJobsMock }
        }
        throw new Error(`Unexpected table in test fake: ${String(table)}`)
      }
    })
    wikiHandle = installTestWiki({
      INSTANCE_ID: 'test-instance',
      config: { scheduler: { maxRetries: 3 } },
      db: {
        transaction: async (fn: any) =>
          fn({
            update: () => ({
              set: () => ({
                where: async () => ({ rowCount: 1 })
              })
            }),
            select: selectImpl
          }),
        select: selectImpl,
        insert: (_table: any) => ({
          values: async (v: any) => {
            if (insertShouldFail) {
              throw new Error('simulated insert failure')
            }
            insertedJobs.push(v)
            return { id: v.id ?? 'fake-id' }
          }
        })
      }
    })
    // -> Bypass `init()` (worker pool + reading tasks/simple/ off disk): only `this.tasks` is read, by
    //    `addJob()`, to derive `useWorker`.
    scheduler.tasks = {}
  })

  after(() => {
    wikiHandle.restore()
  })

  beforeEach(() => {
    insertedJobs = []
    insertShouldFail = false
  })

  test('schedules future jobs from a cron even when a job is already scheduled for that task', async () => {
    scheduleJobsMock = [{ task: 'testTask', cron: '* * * * *', payload: { foo: 'bar' } }]
    // -> Matches `job.task` so the dedupe callback actually runs; its `waitUntil` is far in the
    //    past so it cannot collide with a near-future iteration.
    existingJobsMock = [{ task: 'testTask', waitUntil: new Date(0) }]

    await scheduler.addScheduled()

    // A minutely cron has far more than 10 due iterations in the window, so the 10-addition cap is
    // what stops it.
    assert.equal(insertedJobs.length, 10)

    for (const job of insertedJobs) {
      assert.equal(job.task, 'testTask')
      assert.deepEqual(job.payload, { foo: 'bar' })
      assert.ok(job.waitUntil instanceof Date, 'waitUntil must be a Date, not an ISO string')
      assert.ok(!Number.isNaN(job.waitUntil.getTime()))
      // -> Derived by `addJob` from `this.tasks`, which is empty here.
      assert.equal(job.useWorker, true)
    }

    const times = insertedJobs.map((j) => j.waitUntil.getTime())
    assert.equal(new Set(times).size, times.length)
    for (let i = 1; i < times.length; i++) {
      assert.ok(times[i] > times[i - 1])
    }
  })

  test('adds no jobs and does not throw when the schedule has no due iterations left', async () => {
    // Fires once a year, a week from now, so the window holds no due iteration and the loop ends
    // naturally rather than at the cap.
    const farOff = Temporal.Now.instant()
      .add({ hours: 7 * 24 })
      .toZonedDateTimeISO('UTC')
    scheduleJobsMock = [
      { task: 'leapTask', cron: `0 0 ${farOff.day} ${farOff.month} *`, payload: {} }
    ]
    existingJobsMock = []

    await scheduler.addScheduled()

    assert.equal(insertedJobs.length, 0)
  })

  test('a `*/5 * * * *` cron produces multiple distinct rows capped at 10, and a second call does not duplicate rows already in existingJobs', async () => {
    // The loop's cap counts additions, not iterations examined: a second call skips the 10 rows
    // already scheduled and adds 10 new ones further out. So "does not duplicate" means the two
    // calls' rows never overlap, not that the second call adds nothing.
    scheduleJobsMock = [{ task: 'fiveMinTask', cron: '*/5 * * * *', payload: {} }]
    existingJobsMock = []

    await scheduler.addScheduled()

    assert.equal(insertedJobs.length, 10)
    const firstCallTimes = insertedJobs.map((j) => j.waitUntil.getTime())
    assert.equal(
      new Set(firstCallTimes).size,
      10,
      'all 10 rows from the first call must be distinct'
    )

    existingJobsMock = insertedJobs.map((j) => ({ task: j.task, waitUntil: j.waitUntil }))
    insertedJobs = []

    await scheduler.addScheduled()

    assert.equal(
      insertedJobs.length,
      10,
      'the dedup skip must not stop the loop before its 10-addition cap'
    )
    const secondCallTimes = insertedJobs.map((j) => j.waitUntil.getTime())
    assert.equal(
      new Set(secondCallTimes).size,
      10,
      'all 10 rows from the second call must be distinct'
    )
    for (const t of secondCallTimes) {
      assert.ok(
        !firstCallTimes.includes(t),
        'a second call must not duplicate a waitUntil already present in existingJobs'
      )
    }
  })

  test('a null waitUntil among existingJobs does not crash the dedupe check or block scheduling', async () => {
    scheduleJobsMock = [{ task: 'testTask', cron: '* * * * *', payload: {} }]
    existingJobsMock = [{ task: 'testTask', waitUntil: null }]

    await scheduler.addScheduled()

    assert.equal(insertedJobs.length, 10)
    for (const job of insertedJobs) {
      assert.equal(job.task, 'testTask')
      assert.ok(job.waitUntil instanceof Date)
    }
  })

  test('reports zero jobs added when every addJob insert fails', async () => {
    // -> Hourly rather than minutely: nothing ever succeeds, so the 10-addition cap cannot stop the
    //    loop early and every due iteration in the window is attempted.
    scheduleJobsMock = [{ task: 'testTask', cron: '0 * * * *', payload: {} }]
    existingJobsMock = []
    insertShouldFail = true

    const added = await scheduler.addScheduled()

    assert.equal(added, 0, 'addScheduled() must report zero jobs added')
    assert.equal(insertedJobs.length, 0, 'no row should have been inserted')
  })
})

describe('expireCompletionPromises (fake CARDINAL)', () => {
  let wikiHandle: { restore(): void }

  after(() => {
    wikiHandle.restore()
  })

  beforeEach(() => {
    scheduler.completionPromises = []
  })

  /**
   * `promise` must be a real `Promise` wired to `resolve`/`reject`: `expireCompletionPromises()`
   * attaches a no-op `.catch()` to it before rejecting.
   */
  function makeEntry(ageSeconds: number) {
    const added = (globalThis as any).Temporal.Now.instant().subtract({ seconds: ageSeconds })
    let rejectedWith: Error | undefined
    let resolved = false
    let resolveFn: (value: void) => void
    let rejectFn: (reason?: unknown) => void
    const promise = new Promise<void>((res, rej) => {
      resolveFn = res
      rejectFn = rej
    })
    return {
      entry: {
        id: `job-aged-${ageSeconds}s`,
        added,
        promise,
        resolve: () => {
          resolved = true
          resolveFn()
        },
        reject: (err: Error) => {
          rejectedWith = err
          rejectFn(err)
        }
      },
      getRejection: () => rejectedWith,
      wasResolved: () => resolved
    }
  }

  test('rejects and drops an entry older than 2x staleJobTimeout', () => {
    wikiHandle = installTestWiki({ config: { scheduler: { staleJobTimeout: 10 } } })
    const { entry, getRejection } = makeEntry(25)
    scheduler.completionPromises.push(entry)

    scheduler.expireCompletionPromises()

    assert.equal(scheduler.completionPromises.length, 0)
    assert.match(getRejection()!.message, /Timed out/)
    assert.match(getRejection()!.message, /job-aged-25s/)
  })

  test('leaves an entry younger than the ceiling untouched', () => {
    wikiHandle = installTestWiki({ config: { scheduler: { staleJobTimeout: 10 } } })
    const { entry, getRejection, wasResolved } = makeEntry(5)
    scheduler.completionPromises.push(entry)

    scheduler.expireCompletionPromises()

    assert.equal(scheduler.completionPromises.length, 1)
    assert.equal(getRejection(), undefined)
    assert.equal(wasResolved(), false)
  })

  test('falls back to the default stale job timeout (doubled) when nothing is configured', () => {
    wikiHandle = installTestWiki({ config: { scheduler: {} } })
    const { entry } = makeEntry(5)
    scheduler.completionPromises.push(entry)

    scheduler.expireCompletionPromises()

    assert.equal(scheduler.completionPromises.length, 1)
  })

  test('only removes the expired entries, leaving fresh ones in place', () => {
    wikiHandle = installTestWiki({ config: { scheduler: { staleJobTimeout: 10 } } })
    const stale = makeEntry(25)
    const fresh = makeEntry(1)
    scheduler.completionPromises.push(stale.entry, fresh.entry)

    scheduler.expireCompletionPromises()

    assert.deepEqual(
      scheduler.completionPromises.map((p: any) => p.id),
      [fresh.entry.id]
    )
    assert.ok(stale.getRejection())
  })
})

describe('addJob (fake CARDINAL, rejecting insert)', () => {
  let wikiHandle: { restore(): void }

  before(() => {
    wikiHandle = installTestWiki({
      INSTANCE_ID: 'test-instance',
      config: { scheduler: { maxRetries: 3 } },
      db: {
        insert: (_table: any) => ({
          values: async () => {
            throw new Error('insert failed')
          }
        })
      }
    })
    scheduler.tasks = {}
  })

  after(() => {
    wikiHandle.restore()
  })

  beforeEach(() => {
    scheduler.completionPromises = []
  })

  test('returns undefined and leaves completionPromises empty when the insert rejects', async () => {
    const result = await scheduler.addJob({ task: 'testTask', promise: true })

    assert.equal(result, undefined)
    assert.equal(scheduler.completionPromises.length, 0)
  })

  test('a subsequent expireCompletionPromises() sweep produces no unhandled rejection', async () => {
    let unhandled: unknown
    const onUnhandledRejection = (reason: unknown) => {
      unhandled = reason
    }
    process.on('unhandledRejection', onUnhandledRejection)

    try {
      await scheduler.addJob({ task: 'testTask', promise: true })
      scheduler.expireCompletionPromises()

      // -> An unhandled rejection needs a macrotask turn to fire before its absence is asserted.
      await new Promise((resolve) => setImmediate(resolve))

      assert.equal(scheduler.completionPromises.length, 0)
      assert.equal(
        unhandled,
        undefined,
        'expireCompletionPromises() must not produce an unhandled rejection'
      )
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })
})

describe('stop (fake CARDINAL)', () => {
  let wikiHandle: { restore(): void }
  let destroyCalls: number

  beforeEach(() => {
    destroyCalls = 0
    wikiHandle = installTestWiki({
      // -> 0.05s taskTimeout + the fixed 1s SHUTDOWN_DRAIN_GRACE = a ~1.05s drain bound: fast, yet
      //    clearly separable from resolving immediately.
      config: { scheduler: { taskTimeout: 0.05 } }
    })
    scheduler.pollingRef = setInterval(() => {}, 1_000_000)
    scheduler.scheduledRef = setInterval(() => {}, 1_000_000)
    scheduler.workerPool = {
      destroy: async () => {
        destroyCalls++
      }
    }
    scheduler.listenerHandle = null
    scheduler.inFlightJobs = new Set()
  })

  after(() => {
    wikiHandle.restore()
    scheduler.workerPool = null
    scheduler.pollingRef = null
    scheduler.scheduledRef = null
    scheduler.inFlightJobs = new Set()
  })

  test('clears pollingRef and scheduledRef synchronously, before anything is awaited', () => {
    assert.ok(scheduler.pollingRef, 'test setup sanity check')
    assert.ok(scheduler.scheduledRef, 'test setup sanity check')

    const stopPromise = scheduler.stop()

    // -> `stop()` has run synchronously up to its first `await` by the time control returns here.
    assert.equal(scheduler.pollingRef, null)
    assert.equal(scheduler.scheduledRef, null)

    return stopPromise
  })

  test('awaits an in-flight job rather than dropping it', async () => {
    let settled = false
    const job: Promise<void> = new Promise((resolve) =>
      setTimeout(() => {
        settled = true
        resolve()
      }, 100)
    )
    scheduler.inFlightJobs.add(job)

    await scheduler.stop()

    assert.equal(settled, true, 'stop() must not resolve before the in-flight job settled')
    assert.equal(destroyCalls, 1, 'the worker pool must still be destroyed after the drain')
  })

  test('a never-settling in-flight job does not prevent stop() from resolving within the bound', async () => {
    scheduler.inFlightJobs.add(new Promise<void>(() => {}))

    const start = Date.now()
    await scheduler.stop()
    const elapsed = Date.now() - start

    assert.ok(elapsed < 3000, `expected stop() to resolve within the bound, took ${elapsed}ms`)
    assert.ok(
      elapsed >= 900,
      `expected stop() to wait out most of the bound rather than short-circuiting, took ${elapsed}ms`
    )
    assert.equal(destroyCalls, 1, 'the worker pool must still be destroyed once the bound elapses')
  })
})
