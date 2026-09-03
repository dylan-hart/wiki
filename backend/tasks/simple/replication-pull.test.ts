import { describe, test, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import { task as replicationPull } from './replication-pull.ts'
import { installTestWiki } from '../../test/mocks.ts'

/**
 * `task()` is the thin `replicationPull` scheduled-job wrapper -- it only ever delegates to
 * `WIKI.models.replication.pull()`, logging and rethrowing on failure so the scheduler's own
 * retry/history bookkeeping sees it.
 */

let wikiHandle: { restore(): void }

after(() => {
  wikiHandle.restore()
})

describe('replication-pull.task', () => {
  test('delegates to WIKI.models.replication.pull()', async () => {
    const pull = mock.fn(async () => {})
    wikiHandle = installTestWiki({ models: { replication: { pull } } })

    await replicationPull()

    assert.equal(pull.mock.callCount(), 1)
  })

  test('logs and rethrows when the pull fails', async () => {
    const pull = mock.fn(async () => {
      throw new Error('source instance unreachable')
    })
    wikiHandle = installTestWiki({ models: { replication: { pull } } })

    await assert.rejects(replicationPull(), /source instance unreachable/)
  })
})
