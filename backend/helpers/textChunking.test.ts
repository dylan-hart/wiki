import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { CHUNK_OVERLAP_WORDS, CHUNK_SIZE_WORDS, chunkText } from './textChunking.ts'

function words(count: number, prefix = 'w'): string {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(' ')
}

describe('helpers/textChunking', () => {
  test('empty content yields no chunks', () => {
    assert.deepEqual(chunkText(''), [])
  })

  test('whitespace-only content yields no chunks', () => {
    assert.deepEqual(chunkText('   \n\t  '), [])
  })

  test('content shorter than one chunk yields a single chunk with all the text', () => {
    const text = words(10)
    const chunks = chunkText(text)
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0]!.index, 0)
    assert.equal(chunks[0]!.text, text)
  })

  test('content exactly one chunk-width yields a single chunk', () => {
    const text = words(CHUNK_SIZE_WORDS)
    const chunks = chunkText(text)
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0]!.text, text)
  })

  test('multiple spaces/newlines collapse into single word separators', () => {
    const chunks = chunkText('a  b\n\nc\t\td')
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0]!.text, 'a b c d')
  })

  test('long content produces multiple overlapping chunks with correct index sequence', () => {
    const totalWords = CHUNK_SIZE_WORDS * 2 + 10
    const text = words(totalWords)
    const chunks = chunkText(text)

    assert.ok(chunks.length > 1)
    assert.deepEqual(
      chunks.map((c) => c.index),
      chunks.map((_, i) => i)
    )

    // -> Every chunk but the last is exactly CHUNK_SIZE_WORDS words
    for (const chunk of chunks.slice(0, -1)) {
      assert.equal(chunk.text.split(' ').length, CHUNK_SIZE_WORDS)
    }

    // -> Consecutive chunks share exactly CHUNK_OVERLAP_WORDS words at the boundary
    for (let i = 1; i < chunks.length; i++) {
      const prevWords = chunks[i - 1]!.text.split(' ')
      const currWords = chunks[i]!.text.split(' ')
      const prevTail = prevWords.slice(-CHUNK_OVERLAP_WORDS)
      const currHead = currWords.slice(0, CHUNK_OVERLAP_WORDS)
      assert.deepEqual(currHead, prevTail)
    }

    // -> The last chunk is not dropped and is not a redundant duplicate of the previous one
    const last = chunks.at(-1)!
    assert.ok(last.text.length > 0)
    assert.notEqual(last.text, chunks.at(-2)!.text)
    // -> Every source word appears somewhere in the chunked output
    assert.ok(last.text.endsWith(`w${totalWords - 1}`))
  })

  test('content one word longer than a single chunk produces exactly two chunks', () => {
    const totalWords = CHUNK_SIZE_WORDS + 1
    const text = words(totalWords)
    const chunks = chunkText(text)
    assert.equal(chunks.length, 2)
    assert.equal(chunks[1]!.text.split(' ').at(-1), `w${totalWords - 1}`)
  })
})
