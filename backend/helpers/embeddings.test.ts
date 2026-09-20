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
    // -> Each `*.test.ts` file is its own process under `node --test`, so nothing has attempted a
    //    load yet. Must run before the forced load failure below.
    assert.equal(isEmbeddingAvailable(), true)
  })
})

/**
 * `embedText` imports `@huggingface/transformers` lazily, so the "unusable on this platform" path
 * is forced by renaming the package out of `node_modules` for one test, rather than needing
 * `--experimental-test-module-mocks` to intercept the import.
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
      // -> Nothing installed to rename: import() fails on its own, which is the same outcome.
    }

    try {
      const warn = mock.fn((_scope: string, _message: string, _fields?: unknown) => {})
      // -> `models` deliberately carries no `extensions` key (`createWikiStub` defaults it to
      //    `{}`), as a worker thread's minimal `CARDINAL.models` might: the failure path must still
      //    not throw.
      wikiHandle = installTestWiki({ logger: { warn, debug: mock.fn() } })

      const result = await embedText('irrelevant')

      assert.equal(result, null)
      assert.equal(warn.mock.calls.length, 1)
      assert.equal(warn.mock.calls[0].arguments[0], 'search')
      // -> The failure is cached for the rest of this process
      assert.equal(isEmbeddingAvailable(), false)

      // -> so a second call short-circuits rather than attempting another import
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
 * The real import failure above can only fire once per process (`loadFailed` short-circuits every
 * later call), so warn-before-record with `extensions` present is pinned as a source-order fact
 * instead: a throw from `noteLoadFailure` must never be able to suppress the warn log.
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
