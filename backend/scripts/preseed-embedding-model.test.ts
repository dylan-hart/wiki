/**
 * Pure unit tests for `preseed-embedding-model.ts`'s testable seam (OpenProject #3324). No real
 * `@huggingface/transformers` pipeline construction and no network/model download — the stubbed
 * loader below stands in for it, the same way `helpers/embeddings.test.ts#makeExtractor` stubs the
 * extractor rather than loading the real model.
 */
import assert from 'node:assert/strict'
import { describe, mock, test } from 'node:test'

import { MODEL_NAME } from '../helpers/embeddings.ts'
import { preseedModel } from './preseed-embedding-model.ts'

describe('preseedModel', () => {
  test('loads the feature-extraction pipeline for the exact model embeddings.ts uses', async () => {
    const loadPipeline = mock.fn(async (_task: string, _model: string) => ({}))

    await preseedModel(loadPipeline)

    assert.equal(loadPipeline.mock.calls.length, 1)
    assert.equal(loadPipeline.mock.calls[0].arguments[0], 'feature-extraction')
    assert.equal(loadPipeline.mock.calls[0].arguments[1], MODEL_NAME)
  })

  test('propagates a load failure rather than swallowing it', async () => {
    const loadPipeline = mock.fn(async () => {
      throw new Error('simulated download failure')
    })

    await assert.rejects(() => preseedModel(loadPipeline), /simulated download failure/)
  })
})
