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

/** A stub extractor shaped like `@huggingface/transformers`'s pipeline output, with no real inference. */
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
 * `embedText` consults `@huggingface/transformers` (via a lazy dynamic `import()`) before ever
 * building a pipeline, so this covers the "unusable on this platform" path the same way
 * `helpers/images.test.ts` covers Sharp being reported installed but failing to import: by renaming
 * `node_modules` out of the way for the duration of one test and restoring it in `finally`, rather
 * than needing `--experimental-test-module-mocks` to intercept the import directly.
 */
describe('embedText — model unavailable', () => {
  let wikiHandle: { restore(): void }
  after(() => {
    wikiHandle?.restore()
  })

  test('returns null instead of throwing when the runtime cannot be imported and CARDINAL.models has no extensions (OpenProject #3295)', async () => {
    const nodeModulesDir = path.join(import.meta.dirname, '..', 'node_modules', '@huggingface')
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
      const warn = mock.fn((_scope: string, _message: string, _fields?: unknown) => {})
      // -> `models` deliberately carries no `extensions` key -- `test/mocks.ts#createWikiStub`
      //    defaults `models` to `{}`, so this reproduces `backend/worker.ts`'s exact pre-fix shape
      //    (and would reproduce it again if a future edit there ever dropped `extensions`). Before the
      //    fix, `getExtractor()`'s catch block called `CARDINAL.models.extensions.noteLoadFailure()`
      //    unconditionally here and threw `Cannot read properties of undefined (reading
      //    'noteLoadFailure')` before the warn log below ever ran, escaping `embedText()`'s "never
      //    throws" contract as an unhandled job failure.
      wikiHandle = installTestWiki({ logger: { warn, debug: mock.fn() } })

      const result = await embedText('irrelevant')

      assert.equal(result, null)
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

/**
 * The real import-failure trigger above can only fire once per process (`getExtractor()`'s own
 * `if (loadFailed) return null` guard), so it is spent proving the extensions-absent regression is
 * fixed. Whether `CARDINAL.models.extensions.noteLoadFailure()` is called *before or after* the warn
 * log, when `extensions` IS present, is instead verified as a source-order fact rather than by forcing
 * a second live failure — this is what actually guarantees a future failure in `noteLoadFailure`
 * itself (or in whatever recording step replaces it) can never suppress the warn log again.
 */
describe('getExtractor catch block source order — OpenProject #3295', () => {
  test('warns before calling CARDINAL.models.extensions?.noteLoadFailure()', async () => {
    const embeddingsSource = await fs.readFile(
      path.join(import.meta.dirname, 'embeddings.ts'),
      'utf8'
    )
    const warnIdx = embeddingsSource.indexOf(
      "CARDINAL.logger.warn('search', 'could not load the local embedding model'"
    )
    const noteIdx = embeddingsSource.indexOf(
      'CARDINAL.models.extensions?.noteLoadFailure(specifier)'
    )
    assert.notEqual(warnIdx, -1, 'expected the warn log call to still exist verbatim')
    assert.notEqual(noteIdx, -1, 'expected an optional-chained noteLoadFailure call to still exist')
    assert.ok(warnIdx < noteIdx, 'the warn log must run before recording the load failure')
  })
})
