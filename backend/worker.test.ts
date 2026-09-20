/**
 * A source scan: `worker.ts` runs top-level `await`s against the real db/config boot path and
 * reads `threadId`/`workerData` at module scope, so a test cannot import it.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

const backendDir = import.meta.dirname
const workerTs = readFileSync(path.join(backendDir, 'worker.ts'), 'utf8')

describe('worker.ts CARDINAL.models', () => {
  test('includes extensions alongside settings in the worker thread minimal model set', () => {
    const modelsBlockStart = workerTs.indexOf('CARDINAL.models = {')
    assert.notEqual(modelsBlockStart, -1, 'expected worker.ts to assign CARDINAL.models')
    const modelsBlockEnd = workerTs.indexOf('} as CardinalGlobal', modelsBlockStart)
    assert.notEqual(modelsBlockEnd, -1)
    const modelsBlock = workerTs.slice(modelsBlockStart, modelsBlockEnd)

    assert.match(modelsBlock, /settings: \(await import\('\.\/models\/settings\.ts'\)\)\.settings/)
    assert.match(
      modelsBlock,
      /extensions: \(await import\('\.\/models\/extensions\.ts'\)\)\.extensions/,
      'expected worker.ts to build CARDINAL.models.extensions, which helpers/embeddings.ts#getExtractor() needs to record a load failure without throwing (OpenProject #3295)'
    )
  })
})
