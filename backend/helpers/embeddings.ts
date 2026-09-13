import { createHash } from 'node:crypto'

/**
 * Local text embedding.
 *
 * STUB pending Task #3097 ("Local embedding model integration (@xenova/transformers)"), which owns
 * this file for real. #3097's documented interface is exactly `isEmbeddingAvailable()` /
 * `embedText(text): Promise<number[] | null>` -- written here to that contract so the embed-page
 * worker job (#3098, the sole caller during parallel development) has something real to call and
 * test against. This implementation is deliberately NOT the real `@xenova/transformers` model: it
 * derives a deterministic pseudo-embedding from a hash of the input, so it is fast, offline, and
 * reproducible for a chunk's text, but it carries none of the actual semantic meaning a real
 * embedding model would. Expect this file to be replaced wholesale by #3097's own implementation at
 * integration.
 */

/** Matches `Xenova/all-MiniLM-L6-v2`'s real output dimensionality (#3097's own documented target). */
export const EMBEDDING_DIMENSIONS = 384

/** Always true for this stub -- the real implementation reports whether the model can load. */
export function isEmbeddingAvailable(): boolean {
  return true
}

/**
 * A deterministic, unit-length pseudo-embedding for `text`.
 *
 * Never throws: an empty/whitespace-only input answers `null`, matching the real implementation's
 * contract of reporting unavailability as `null` rather than an exception.
 */
export async function embedText(text: string): Promise<number[] | null> {
  if (!text || text.trim().length < 1) {
    return null
  }

  const vector = Array.from<number>({ length: EMBEDDING_DIMENSIONS }).fill(0)
  // -> Repeated SHA-256 rounds, each seeded by the previous digest, to fill a 384-length vector from
  //    a 32-byte hash -- enough spread that two different inputs produce visibly different vectors,
  //    without pulling in any real model.
  let digest = createHash('sha256').update(text).digest()
  let filled = 0
  while (filled < EMBEDDING_DIMENSIONS) {
    for (let i = 0; i < digest.length && filled < EMBEDDING_DIMENSIONS; i++) {
      // -> Centered on 0 so the vector is not all-positive, which would make every embedding point
      //    into the same cosine-similarity octant
      vector[filled] = digest[i]! / 255 - 0.5
      filled++
    }
    digest = createHash('sha256').update(digest).digest()
  }

  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0))
  return magnitude > 0 ? vector.map((v) => v / magnitude) : vector
}
