/**
 * `CARDINAL.capabilities` reaching a worker thread (OpenProject #3124, triaged from Issue #3117).
 *
 * `core/db.ts#syncSchemas()` sets `CARDINAL.capabilities` once, on the main process, at boot.
 * `worker.ts` builds its own minimal `CARDINAL` and never called `syncSchemas()` itself, so
 * `CARDINAL.capabilities` always read `undefined` on a worker thread -- which made
 * `tasks/workers/embed-page.ts#embedPage()`'s `if (!CARDINAL.capabilities?.semanticSearch) return` guard
 * always true in production, silently no-opping the scheduled per-page embedding job regardless of
 * whether pgvector was actually installed and enabled.
 *
 * The fix forwards `CARDINAL.capabilities` through the same `workerData` object `INSTANCE_ID`'s
 * `parentInstanceId` already travels on (`core/scheduler.ts`'s `poolOptions`), at pool-creation
 * time -- after the db boot phase that populates it. Own file rather than a describe inside
 * `core/schedulerWorkerIdentity.test.ts`, matching that file's own reasoning for being separate from
 * `core/scheduler.test.ts`: this one starts a real thread instead of staying source-scan-only for its
 * transport proof.
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { FixedThreadPool } from 'poolifier'

const backendDir = path.join(import.meta.dirname, '..')
const schedulerTs = readFileSync(path.join(backendDir, 'core/scheduler.ts'), 'utf8')
const workerTs = readFileSync(path.join(backendDir, 'worker.ts'), 'utf8')
const globalDts = readFileSync(path.join(backendDir, 'types/global.d.ts'), 'utf8')

describe('worker thread capabilities', () => {
  test("the pool's workerOptions carry CARDINAL.capabilities alongside parentInstanceId", () => {
    assert.match(
      schedulerTs,
      /workerOptions: \{\s*workerData: \{ parentInstanceId: CARDINAL\.INSTANCE_ID, capabilities: CARDINAL\.capabilities \}/
    )
  })

  test('worker.ts reads capabilities out of workerData and assigns it onto its own CARDINAL', () => {
    assert.match(
      workerTs,
      /capabilities: \(workerData as \{ capabilities\?: CardinalGlobal\['capabilities'\] \} \| null\)\?\.capabilities/
    )
    // -> Settled in the same object literal as INSTANCE_ID, so it exists before anything on this
    //    thread (including the logger and any later-imported task) could read it.
    const idIdx = workerTs.indexOf('INSTANCE_ID: workerInstanceId(')
    const capIdx = workerTs.indexOf('capabilities: (workerData as')
    const loggerIdx = workerTs.indexOf('CARDINAL.logger = logger.init()')
    assert.notEqual(idIdx, -1)
    assert.notEqual(capIdx, -1)
    assert.ok(
      idIdx < capIdx,
      'capabilities should be assigned in the same CARDINAL literal as INSTANCE_ID'
    )
    assert.ok(capIdx < loggerIdx, 'capabilities must be settled before the logger is built')
  })

  test('global.d.ts no longer claims a worker thread never has capabilities set', () => {
    assert.doesNotMatch(globalDts, /worker thread never calls `syncSchemas\(\)`\)/)
    assert.match(globalDts, /workerData/)
  })

  test("poolifier's workerData really does carry capabilities into the thread", async () => {
    // -> The claim a source scan cannot make, mirroring
    //    `schedulerWorkerIdentity.test.ts`'s parentInstanceId proof.
    const capabilities = { semanticSearch: true }
    const pool = new FixedThreadPool<unknown, unknown>(
      1,
      path.join(backendDir, 'test/fixtures/workerCapabilitiesWorker.ts'),
      {
        errorHandler: () => {},
        exitHandler: () => {},
        workerOptions: { workerData: { parentInstanceId: 'parent-instance', capabilities } }
      }
    )
    try {
      const received = await pool.execute({})
      assert.deepEqual(received, capabilities)
    } finally {
      await pool.destroy()
    }
  })

  test('an undefined capabilities value forwards as undefined, not a throw', async () => {
    const pool = new FixedThreadPool<unknown, unknown>(
      1,
      path.join(backendDir, 'test/fixtures/workerCapabilitiesWorker.ts'),
      {
        errorHandler: () => {},
        exitHandler: () => {},
        workerOptions: { workerData: { parentInstanceId: 'parent-instance' } }
      }
    )
    try {
      const received = await pool.execute({})
      assert.equal(received, undefined)
    } finally {
      await pool.destroy()
    }
  })
})
