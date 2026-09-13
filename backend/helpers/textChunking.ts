/**
 * Split a page's rendered plain-text content into overlapping passages for embedding.
 *
 * Pure text-in, chunks-out: no `WIKI` global, no database, no embedding model. Consumes text that has
 * already been through the render pipeline (`pages.searchContent` -- see `models/rendering.ts`), it
 * does not parse markdown itself.
 *
 * NOTE: This shape/implementation is shared contract territory with Task #3096 ("Chunk page content
 * into overlapping passages"), which owns this file. Written here to the documented interface so the
 * embed-page worker job (#3098) has something real to chunk against during parallel development --
 * expect this to be reconciled against #3096's own version at integration.
 */

/** Target chunk size, in words. A future tuning pass changes this one constant. */
export const CHUNK_SIZE_WORDS = 250

/** How many trailing words of one chunk reappear at the start of the next. */
export const CHUNK_OVERLAP_WORDS = 50

/** One chunk of a page's content, indexed in document order. */
export interface TextChunk {
  index: number
  text: string
}

// -> Asserted once, at module load, rather than inside chunkText() on every call: a future edit to
//    either constant that let the step reach zero or go negative would otherwise loop forever the
//    first time chunkText() actually ran, rather than failing loudly and immediately.
const CHUNK_STEP_WORDS = CHUNK_SIZE_WORDS - CHUNK_OVERLAP_WORDS
if (CHUNK_STEP_WORDS <= 0) {
  throw new Error('CHUNK_OVERLAP_WORDS must be smaller than CHUNK_SIZE_WORDS')
}

/**
 * Split `text` into `CHUNK_SIZE_WORDS`-word passages, each overlapping the previous by
 * `CHUNK_OVERLAP_WORDS` words.
 *
 * Words are whatever `\s+` separates -- multiple spaces/newlines collapse, so word counts stay
 * meaningful against already-rendered plain text. Empty or whitespace-only input yields no chunks.
 * Content shorter than one window yields a single chunk holding all of it. The step between window
 * starts (`CHUNK_SIZE_WORDS - CHUNK_OVERLAP_WORDS`) is asserted positive at module load so a future
 * edit to either constant cannot silently create a zero/negative step and loop forever.
 */
export function chunkText(text: string): TextChunk[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length < 1) {
    return []
  }

  const chunks: TextChunk[] = []
  let start = 0
  let index = 0
  while (start < words.length) {
    const end = Math.min(start + CHUNK_SIZE_WORDS, words.length)
    chunks.push({ index, text: words.slice(start, end).join(' ') })
    index += 1
    if (end >= words.length) {
      break
    }
    start += CHUNK_STEP_WORDS
  }
  return chunks
}
