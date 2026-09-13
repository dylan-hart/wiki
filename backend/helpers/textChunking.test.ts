import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { chunkText, CHUNK_SIZE_WORDS, CHUNK_OVERLAP_WORDS } from './textChunking.ts'

function words(n: number, prefix = 'word') {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ')
}

describe('textChunking', () => {
  test('empty content produces no chunks', () => {
    assert.deepEqual(chunkText(''), [])
  })

  test('whitespace-only content produces no chunks', () => {
    assert.deepEqual(chunkText('   \n\t  '), [])
  })

  test('content shorter than the overlap window produces a single chunk', () => {
    const text = words(10)
    const result = chunkText(text)
    assert.equal(result.length, 1)
    assert.deepEqual(result[0], { index: 0, text })
  })

  test('content shorter than one full chunk produces a single chunk containing everything', () => {
    const text = words(100)
    const result = chunkText(text)
    assert.equal(result.length, 1)
    assert.equal(result[0].index, 0)
    assert.equal(result[0].text, text)
  })

  test('content exactly one chunk-width produces a single chunk', () => {
    const text = words(CHUNK_SIZE_WORDS)
    const result = chunkText(text)
    assert.equal(result.length, 1)
    assert.equal(result[0].text, text)
  })

  test('long content produces multiple overlapping chunks with correct indices and boundaries', () => {
    const totalWords = CHUNK_SIZE_WORDS * 3
    const text = words(totalWords)
    const wordList = text.split(' ')
    const result = chunkText(text)

    assert.ok(result.length > 1)

    // indices are sequential starting at 0
    result.forEach((chunk, i) => assert.equal(chunk.index, i))

    const step = CHUNK_SIZE_WORDS - CHUNK_OVERLAP_WORDS
    result.forEach((chunk, i) => {
      const start = i * step
      const end = Math.min(start + CHUNK_SIZE_WORDS, wordList.length)
      const expected = wordList.slice(start, end).join(' ')
      assert.equal(chunk.text, expected)
    })

    // consecutive chunks share exactly CHUNK_OVERLAP_WORDS words of overlap
    for (let i = 1; i < result.length; i++) {
      const prevWords = result[i - 1].text.split(' ')
      const currWords = result[i].text.split(' ')
      const prevTail = prevWords.slice(prevWords.length - CHUNK_OVERLAP_WORDS)
      const currHead = currWords.slice(0, CHUNK_OVERLAP_WORDS)
      if (prevWords.length >= CHUNK_OVERLAP_WORDS && currWords.length >= CHUNK_OVERLAP_WORDS) {
        assert.deepEqual(currHead, prevTail)
      }
    }

    // last chunk reaches the end of the content with no duplicate trailing chunk
    assert.ok(result[result.length - 1].text.endsWith(`word${totalWords - 1}`))
  })

  test('collapses runs of whitespace/newlines between words', () => {
    const text = 'alpha   beta\n\ncharlie\tdelta'
    const result = chunkText(text)
    assert.equal(result.length, 1)
    assert.equal(result[0].text, 'alpha beta charlie delta')
  })

  test('does not produce a redundant final chunk wholly contained in the previous overlap', () => {
    // one step past a chunk boundary by a small remainder
    const totalWords = CHUNK_SIZE_WORDS + 5
    const text = words(totalWords)
    const result = chunkText(text)
    // should be exactly 2 chunks: [0, CHUNK_SIZE_WORDS) and [step, totalWords)
    assert.equal(result.length, 2)
    assert.equal(
      result[1].text.split(' ').length,
      totalWords - (CHUNK_SIZE_WORDS - CHUNK_OVERLAP_WORDS)
    )
  })
})
