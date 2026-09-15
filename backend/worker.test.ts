/**
 * `worker.ts`'s own deliberately minimal `CARDINAL.models` (OpenProject #3295).
 *
 * `worker.ts` is not directly unit-testable: it runs top-level `await`s against the real db/config
 * boot path and reads real `threadId`/`workerData` at module scope, so it cannot simply be imported
 * by a test the way an ordinary module can. Its own coverage is source-scan style instead, matching
 * the existing precedent for this same file: `core/schedulerWorkerIdentity.test.ts` and
 * `core/schedulerWorkerCapabilities.test.ts`.
 *
 * What this guards: `embedPage` worker jobs (`tasks/workers/embed-page.ts`) always run on this
 * thread, and `helpers/embeddings.ts#getExtractor()`'s failure-recovery path calls
 * `CARDINAL.models.extensions.noteLoadFailure()`. Before this fix, `ensureDb()`'s `CARDINAL.models` was
 * `{ settings }` only, so that call threw `Cannot read properties of undefined (reading
 * 'noteLoadFailure')` before the intended warn log ever ran -- turning a load failure this module is
 * explicitly designed to degrade gracefully from into an unhandled job crash instead.
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
