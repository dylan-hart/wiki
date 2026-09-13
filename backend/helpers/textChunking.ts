/**
 * Splits a page's already-rendered plain-text content into overlapping word-based
 * passages, for downstream embedding (WP #3095/#3097/#3098). Pure text-in/chunks-out:
 * no `WIKI` global, no database, no embedding model.
 *
 * The returned shape (`{ index, text }`, in order) maps 1:1 onto the
 * `pageEmbeddingChunks` table's `chunkIndex`/`chunkText` columns with no bespoke glue.
 */

/** Target size of one chunk, in words. Tune here only — never inline the number. */
export const CHUNK_SIZE_WORDS = 250

/** Overlap between consecutive chunks, in words. Tune here only — never inline the number. */
export const CHUNK_OVERLAP_WORDS = 50

if (CHUNK_OVERLAP_WORDS >= CHUNK_SIZE_WORDS) {
  throw new Error('CHUNK_OVERLAP_WORDS must be smaller than CHUNK_SIZE_WORDS')
}

export type TextChunk = {
  index: number
  text: string
}

/**
 * Splits `text` into overlapping passages of `CHUNK_SIZE_WORDS` words, advancing
 * `CHUNK_SIZE_WORDS - CHUNK_OVERLAP_WORDS` words per step so consecutive chunks share
 * `CHUNK_OVERLAP_WORDS` words of overlap. Empty or whitespace-only content yields no
 * chunks; content no longer than one chunk yields a single chunk containing it all.
 */
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
