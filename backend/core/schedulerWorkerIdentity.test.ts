/**
 * A worker thread's identity: the parent's id travels on piscina's `workerData` and the worker
 * settles its own id before its logger exists, so its boot lines and its job lines share one
 * identity.
 *
 * The derivation is pure and covered by `helpers/bootSummary.test.ts`; this file is the transport,
 * and starts a real thread.
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
    // -> Open-ended on purpose: `workerData` carries other keys too, and this only cares that the
    //    id is on it.
    assert.match(schedulerTs, /workerData: \{ parentInstanceId: CARDINAL\.INSTANCE_ID,/)
  })

  test('no job payload carries an INSTANCE_ID any more, in either direction', () => {
    // -> A per-job id would overwrite the one the worker settled at boot. Both halves are refused:
    //    the sender in `executeOnWorker` and the receiver in `worker.ts`'s exported handler.
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
    // -> The claim a source scan cannot make. The fixture derives its id the way `worker.ts` does
    //    and answers with it.
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
