import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { EMBEDDING_DIMENSIONS, embedText, isEmbeddingAvailable } from './embeddings.ts'

describe('helpers/embeddings', () => {
  test('isEmbeddingAvailable reports true for this stub', () => {
    assert.equal(isEmbeddingAvailable(), true)
  })

  test('embedText returns a vector of the documented dimensionality', async () => {
    const vector = await embedText('some page content')
    assert.ok(vector)
    assert.equal(vector!.length, EMBEDDING_DIMENSIONS)
    assert.ok(vector!.every((v) => Number.isFinite(v)))
  })

  test('embedText returns null for empty/whitespace-only text', async () => {
    assert.equal(await embedText(''), null)
    assert.equal(await embedText('   \n\t '), null)
  })

  test('embedText is deterministic for the same input', async () => {
    const a = await embedText('the quick brown fox')
    const b = await embedText('the quick brown fox')
    assert.deepEqual(a, b)
  })

  test('embedText differs for different input', async () => {
    const a = await embedText('the quick brown fox')
    const b = await embedText('a completely different sentence')
    assert.notDeepEqual(a, b)
  })
})
