import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, describe, mock, test } from 'node:test'
import {
  EMBEDDING_DIMENSIONS,
  embedText,
  extractEmbedding,
  isEmbeddingAvailable
} from './embeddings.ts'

import { installTestWiki } from '../test/mocks.ts'

/** A stub extractor shaped like `@xenova/transformers`'s pipeline output, with no real inference. */
function makeExtractor(overrides: { data?: ArrayLike<number>; fail?: Error } = {}) {
  return mock.fn(async (_text: string, _options: { pooling: 'mean'; normalize: boolean }) => {
    if (overrides.fail) {
      throw overrides.fail
    }
    return { data: overrides.data ?? new Float32Array(EMBEDDING_DIMENSIONS).fill(0.1) }
  })
}

describe('extractEmbedding', () => {
  let wikiHandle: { restore(): void }
  after(() => {
    wikiHandle?.restore()
  })

  test('returns a 384-length numeric vector for ordinary text', async () => {
    const extract = makeExtractor()
    const result = await extractEmbedding('the quick brown fox', extract)

    assert.ok(Array.isArray(result))
    assert.equal(result!.length, EMBEDDING_DIMENSIONS)
    assert.ok(result!.every((value) => typeof value === 'number'))
    assert.equal(extract.mock.calls.length, 1)
    assert.equal(extract.mock.calls[0].arguments[0], 'the quick brown fox')
    assert.deepEqual(extract.mock.calls[0].arguments[1], { pooling: 'mean', normalize: true })
  })

  test('returns null, not a thrown error, when running the model fails', async () => {
    const warn = mock.fn()
    wikiHandle = installTestWiki({ logger: { warn, debug: mock.fn() } })

    const extract = makeExtractor({ fail: new Error('onnx runtime error') })
    const result = await extractEmbedding('irrelevant', extract)

    assert.equal(result, null)
    assert.equal(warn.mock.calls.length, 1)
    assert.equal(warn.mock.calls[0].arguments[0], 'search')
  })
})

describe('isEmbeddingAvailable', () => {
  test('is optimistic before any load has been attempted', () => {
    // -> This process may or may not have already exercised `embedText` in an earlier test file (each
    //    `*.test.ts` file is its own process under `node --test`, so within this file nothing has
    //    attempted a real load yet unless a test below forces one).
    assert.equal(isEmbeddingAvailable(), true)
  })
})

/**
 * `embedText` consults `@xenova/transformers` (via a lazy dynamic `import()`) before ever building a
 * pipeline, so this covers the "unusable on this platform" path the same way `helpers/images.test.ts`
 * covers Sharp being reported installed but failing to import: by renaming `node_modules` out of the
 * way for the duration of one test and restoring it in `finally`, rather than needing
 * `--experimental-test-module-mocks` to intercept the import directly.
 */
describe('embedText — model unavailable', () => {
  let wikiHandle: { restore(): void }
  after(() => {
    wikiHandle?.restore()
  })

  test('returns null and records a load failure when the runtime cannot be imported', async () => {
    const nodeModulesDir = path.join(import.meta.dirname, '..', 'node_modules', '@xenova')
    const packageDir = path.join(nodeModulesDir, 'transformers')
    const disabledDir = path.join(nodeModulesDir, '.transformers-disabled-for-test')

    let wasRenamed = false
    try {
      await fs.rename(packageDir, disabledDir)
      wasRenamed = true
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        throw err
      }
      // -> Nothing installed to rename out of the way; import() will fail on its own
      //    (ERR_MODULE_NOT_FOUND), which is the same outcome this test verifies either way.
    }

    try {
      const noteLoadFailure = mock.fn()
      const warn = mock.fn()
      wikiHandle = installTestWiki({
        models: { extensions: { noteLoadFailure } },
        logger: { warn, debug: mock.fn() }
      })

      const result = await embedText('irrelevant')

      assert.equal(result, null)
      assert.equal(noteLoadFailure.mock.calls.length, 1)
      assert.equal(noteLoadFailure.mock.calls[0].arguments[0], '@xenova/transformers')
      assert.equal(warn.mock.calls.length, 1)
      assert.equal(warn.mock.calls[0].arguments[0], 'search')
      // -> The failure is now cached for the rest of this process, same as a real failed load would be
      assert.equal(isEmbeddingAvailable(), false)

      // -> A second call does not attempt another import — it short-circuits on the cached failure
      const secondResult = await embedText('irrelevant again')
      assert.equal(secondResult, null)
    } finally {
      if (wasRenamed) {
        await fs.rename(disabledDir, packageDir)
      }
    }
  })
})
