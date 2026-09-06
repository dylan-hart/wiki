/**
 * Worker thread identity (OpenProject #2671, audit N8).
 *
 * `worker.ts` used to boot as the literal `'worker'` and overwrite `WIKI.INSTANCE_ID` with the
 * parent's id on its first job, so its own boot lines and its job lines were filed under two
 * different identities. The parent id now travels on poolifier's `workerData` (`core/scheduler.ts`'s
 * `poolOptions`) and the id is settled before the worker's logger exists.
 *
 * Two halves, and both need proving: the derivation (`helpers/bootSummary.test.ts` — pure) and the
 * transport, which is what this file is. Its own file rather than a describe inside
 * `core/scheduler.test.ts` for the same reason `scheduler.execution.test.ts` is one: that file is
 * explicitly the pure, no-worker-pool half, and this one starts a real thread.
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { FixedThreadPool } from 'poolifier'

const backendDir = path.join(import.meta.dirname, '..')
const schedulerTs = readFileSync(path.join(backendDir, 'core/scheduler.ts'), 'utf8')
const workerTs = readFileSync(path.join(backendDir, 'worker.ts'), 'utf8')

describe('worker thread identity', () => {
  test("the pool's workerOptions carry this instance's id, which is how a worker learns its parent", () => {
    assert.match(
      schedulerTs,
      /workerOptions: \{\s*workerData: \{ parentInstanceId: WIKI\.INSTANCE_ID \}/
    )
  })

  test('no job payload carries an INSTANCE_ID any more, in either direction', () => {
    // -> The two halves of the removed per-job overwrite: the sender in `executeOnWorker` and the
    //    receiver at the top of `worker.ts`'s ThreadWorker callback.
    assert.doesNotMatch(schedulerTs, /INSTANCE_ID: `\$\{WIKI\.INSTANCE_ID\}:WKR`/)
    assert.doesNotMatch(workerTs, /WIKI\.INSTANCE_ID = job\.INSTANCE_ID/)
  })

  test('worker.ts settles its id at module scope, before its logger is built', () => {
    const idIdx = workerTs.indexOf('INSTANCE_ID: workerInstanceId(')
    const loggerIdx = workerTs.indexOf('WIKI.logger = logger.init()')
    assert.notEqual(idIdx, -1, 'expected worker.ts to derive its id through workerInstanceId')
    assert.ok(idIdx < loggerIdx, 'the id must be settled before the logger reads it')
    assert.match(workerTs, /workerData as \{ parentInstanceId\?: unknown \} \| null/)
  })

  test("poolifier's workerData really does reach the thread, so the parent id arrives", async () => {
    // -> The claim a source scan cannot make. A `FixedThreadPool` of one, built with exactly the
    //    `workerOptions` shape `scheduler.init()` passes, against a fixture that derives its id the
    //    same way `worker.ts` does and answers with it.
    const pool = new FixedThreadPool<unknown, string>(
      1,
      path.join(backendDir, 'test/fixtures/workerIdentityWorker.ts'),
      {
        errorHandler: () => {},
        exitHandler: () => {},
        workerOptions: { workerData: { parentInstanceId: 'parent-instance' } }
      }
    )
    try {
      const id = await pool.execute({})
      assert.match(id, /^parent-instance\/w\d+$/)
    } finally {
      await pool.destroy()
    }
  })
})
