/**
 * Worker thread identity (OpenProject #2671, audit N8).
 *
 * `worker.ts` used to boot as the literal `'worker'` and overwrite `CARDINAL.INSTANCE_ID` with the
 * parent's id on its first job, so its own boot lines and its job lines were filed under two
 * different identities. The parent id now travels on piscina's `workerData` (`core/scheduler.ts`'s
 * pool construction) and the id is settled before the worker's logger exists.
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
import { Piscina } from 'piscina'

const backendDir = path.join(import.meta.dirname, '..')
const schedulerTs = readFileSync(path.join(backendDir, 'core/scheduler.ts'), 'utf8')
const workerTs = readFileSync(path.join(backendDir, 'worker.ts'), 'utf8')

describe('worker thread identity', () => {
  test("the pool's workerData carries this instance's id, which is how a worker learns its parent", () => {
    // -> `workerData` also carries `capabilities` alongside `parentInstanceId` (OpenProject #3124,
    //    see `schedulerWorkerCapabilities.test.ts`) -- this assertion only cares that the id is still
    //    on the same object, not that it's the only key.
    assert.match(schedulerTs, /workerData: \{ parentInstanceId: CARDINAL\.INSTANCE_ID,/)
  })

  test('no job payload carries an INSTANCE_ID any more, in either direction', () => {
    // -> The two halves of the removed per-job overwrite: the sender in `executeOnWorker` and the
    //    receiver at the top of `worker.ts`'s exported handler.
    assert.doesNotMatch(schedulerTs, /INSTANCE_ID: `\$\{CARDINAL\.INSTANCE_ID\}:WKR`/)
    assert.doesNotMatch(workerTs, /CARDINAL\.INSTANCE_ID = job\.INSTANCE_ID/)
  })

  test('worker.ts settles its id at module scope, before its logger is built', () => {
    const idIdx = workerTs.indexOf('INSTANCE_ID: workerInstanceId(')
    const loggerIdx = workerTs.indexOf('CARDINAL.logger = logger.init()')
    assert.notEqual(idIdx, -1, 'expected worker.ts to derive its id through workerInstanceId')
    assert.ok(idIdx < loggerIdx, 'the id must be settled before the logger reads it')
    assert.match(workerTs, /workerData as \{ parentInstanceId\?: unknown \} \| null/)
  })

  test("piscina's workerData really does reach the thread, so the parent id arrives", async () => {
    // -> The claim a source scan cannot make. A single-worker pool, built with exactly the
    //    `workerData` shape `scheduler.init()` passes, against a fixture that derives its id the
    //    same way `worker.ts` does and answers with it.
    const pool = new Piscina<unknown, string>({
      filename: path.join(backendDir, 'test/fixtures/workerIdentityWorker.ts'),
      minThreads: 1,
      maxThreads: 1,
      workerData: { parentInstanceId: 'parent-instance' }
    })
    try {
      const id = await pool.run({})
      assert.match(id, /^parent-instance\/w\d+$/)
    } finally {
      await pool.destroy()
    }
  })
})
