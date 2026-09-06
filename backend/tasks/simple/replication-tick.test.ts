import { describe, test, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { task as replicationTick } from './replication-tick.ts'
import { installTestWiki } from '../../test/mocks.ts'

/**
 * `task()` is the thin `replicationTick` scheduled-job wrapper -- it only ever delegates to
 * `WIKI.models.replication.tick()` and hands the outcome back for the scheduler to log
 * (OpenProject #2672), same shape as `check-version.test.ts`.
 */

let wikiHandle: { restore(): void }

after(() => {
  wikiHandle.restore()
})

describe('replication-tick.task', () => {
  test('delegates to WIKI.models.replication.tick() and returns what it queued', async () => {
    const tick = mock.fn(async () => 1)
    wikiHandle = installTestWiki({ models: { replication: { tick } } })

    const outcome = await replicationTick()

    assert.equal(tick.mock.callCount(), 1)
    assert.deepEqual(outcome, { summary: 'queued replication pulls', queued: 1 })
  })

  test('an idle tick returns nothing, so the run stays at debug', async () => {
    const tick = mock.fn(async () => 0)
    wikiHandle = installTestWiki({ models: { replication: { tick } } })

    assert.equal(await replicationTick(), undefined)
  })

  test('logs and rethrows when the model call fails', async () => {
    const tick = mock.fn(async () => {
      throw new Error('boom')
    })
    wikiHandle = installTestWiki({ models: { replication: { tick } } })

    await assert.rejects(replicationTick(), /boom/)
  })
})
