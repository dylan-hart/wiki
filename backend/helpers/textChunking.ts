/**
 * Overlapping word-based passages of a page's rendered plain text, for embedding. `{ index, text }`
 * maps 1:1 onto the `pageEmbeddingChunks` table's `chunkIndex`/`chunkText` columns.
 */

export const CHUNK_SIZE_WORDS = 250

export const CHUNK_OVERLAP_WORDS = 50

if (CHUNK_OVERLAP_WORDS >= CHUNK_SIZE_WORDS) {
  throw new Error('CHUNK_OVERLAP_WORDS must be smaller than CHUNK_SIZE_WORDS')
}

export type TextChunk = {
  index: number
  text: string
}

export function chunkText(text: string): TextChunk[] {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) {
    return []
  }

  const step = CHUNK_SIZE_WORDS - CHUNK_OVERLAP_WORDS
  const chunks: TextChunk[] = []

  let start = 0
  let index = 0
  while (true) {
    const end = Math.min(start + CHUNK_SIZE_WORDS, words.length)
    chunks.push({ index, text: words.slice(start, end).join(' ') })
    if (end >= words.length) {
      break
    }
    start += step
    index += 1
  }

  return chunks
}
