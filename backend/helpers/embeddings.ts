/**
 * Local embedding model integration — placeholder.
 *
 * The real implementation (lazy-loading `@xenova/transformers`'s `Xenova/all-MiniLM-L6-v2`
 * pipeline, truncating to the model's own max token count, reporting `null` rather than throwing
 * when the runtime is unusable) is Task #3097's scope (Feature #3091). This file exists only so
 * `models/semanticSearch.ts` (#3101, Feature #3092) can be built and unit-tested against the
 * documented contract without waiting for #3097 to land first — see the Epic #3050 round-2
 * coordination note on WP #3101 ("Contract-only deps (stub, don't block)").
 *
 * Both functions below intentionally report "unavailable" until #3097 replaces this file, so
 * `models/semanticSearch.ts#search` degrades to an empty result set rather than erroring.
 */

/** Whether local embedding inference can run on this system. Always `false` until #3097 lands. */
export function isEmbeddingAvailable(): boolean {
  return false
}

/**
 * Embed a string into the model's vector space, or `null` when inference is unavailable.
 * Always `null` until #3097 lands.
 */
export async function embedText(_text: string): Promise<number[] | null> {
  return null
}
