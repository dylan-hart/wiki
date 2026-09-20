/**
 * `worker.ts` builds its own minimal `CARDINAL` and never calls `syncSchemas()`, so
 * `CARDINAL.capabilities` reaches a worker thread only through the pool's `workerData`. Without it a
 * worker task guarding on a capability (`tasks/workers/embed-page.ts`) silently no-ops.
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { Piscina } from 'piscina'

const backendDir = path.join(import.meta.dirname, '..')
const schedulerTs = readFileSync(path.join(backendDir, 'core/scheduler.ts'), 'utf8')
const workerTs = readFileSync(path.join(backendDir, 'worker.ts'), 'utf8')
const globalDts = readFileSync(path.join(backendDir, 'types/global.d.ts'), 'utf8')

describe('worker thread capabilities', () => {
  test("the pool's workerData carries CARDINAL.capabilities alongside parentInstanceId", () => {
    assert.match(
      schedulerTs,
      /workerData: \{ parentInstanceId: CARDINAL\.INSTANCE_ID, capabilities: CARDINAL\.capabilities \}/
    )
  })

  test('worker.ts reads capabilities out of workerData and assigns it onto its own CARDINAL', () => {
    assert.match(
      workerTs,
      /capabilities: \(workerData as \{ capabilities\?: CardinalGlobal\['capabilities'\] \} \| null\)\s*\?\.capabilities/
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

  test("piscina's workerData really does carry capabilities into the thread", async () => {
    // -> The claim a source scan cannot make
    const capabilities = { semanticSearch: true }
    const pool = new Piscina<unknown, unknown>({
      filename: path.join(backendDir, 'test/fixtures/workerCapabilitiesWorker.ts'),
      minThreads: 1,
      maxThreads: 1,
      workerData: { parentInstanceId: 'parent-instance', capabilities }
    })
    try {
      const received = await pool.run({})
      assert.deepEqual(received, capabilities)
    } finally {
      await pool.destroy()
    }
  })

  test('an undefined capabilities value forwards as undefined, not a throw', async () => {
    const pool = new Piscina<unknown, unknown>({
      filename: path.join(backendDir, 'test/fixtures/workerCapabilitiesWorker.ts'),
      minThreads: 1,
      maxThreads: 1,
      workerData: { parentInstanceId: 'parent-instance' }
    })
    try {
      const received = await pool.run({})
      assert.equal(received, undefined)
    } finally {
      await pool.destroy()
    }
  })
})
