/**
 * The one seam over `@huggingface/transformers` (pure JS/WASM ONNX inference, no native compile
 * step), lazily running `MODEL_NAME` to embed page text for semantic search. Follows
 * `helpers/images.ts`'s Sharp pattern: a load failure is logged and recorded on
 * `CARDINAL.models.extensions`, and `null` is returned rather than thrown, so a page save or a
 * search request degrades instead of crashing.
 *
 * The first embedding call per process downloads the model's ONNX weights (~90MB) from the Hugging
 * Face hub into the library's own cache, unless that cache is already warm — the official Docker
 * image pre-seeds it with `scripts/preseed-embedding-model.ts`. A source checkout still needs
 * network access on first use. See `docs/offline-deployment.md`.
 */

/** The model's output dimension; `core/pgvectorBootstrap.ts`'s `vector(384)` column must match. */
export const EMBEDDING_DIMENSIONS = 384

/** Exported so `scripts/preseed-embedding-model.ts` pre-seeds the exact model this module loads. */
export const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2'

/** Held in a variable so a literal import never has to resolve at typecheck time. */
const specifier = '@huggingface/transformers'

/**
 * The slice of the package's `FeatureExtractionPipeline` this module calls. The package's own types
 * are not imported, since it is loaded dynamically by specifier.
 */
export type FeatureExtractor = (
  text: string,
  options: { pooling: 'mean'; normalize: boolean }
) => Promise<{ data: ArrayLike<number> }>

let extractorPromise: Promise<FeatureExtractor> | null = null

let loadFailed = false

/**
 * Load and run are kept apart deliberately: only a load failure means the runtime itself is
 * unusable here, so only that is recorded and costs `isEmbeddingAvailable()` its optimism.
 */
async function getExtractor(): Promise<FeatureExtractor | null> {
  if (loadFailed) {
    return null
  }
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline } = await import(specifier)
      return (await pipeline('feature-extraction', MODEL_NAME)) as FeatureExtractor
    })()
  }
  try {
    return await extractorPromise
  } catch (err: any) {
    loadFailed = true
    extractorPromise = null
    // -> Warn first, and optional-chain `noteLoadFailure`: this runs on a worker thread, whose
    //    minimal `CARDINAL.models` may lack `extensions`, and recording the failure must never
    //    throw before the real error is logged.
    CARDINAL.logger.warn('search', 'could not load the local embedding model', { error: err })
    CARDINAL.models.extensions?.noteLoadFailure(specifier)
    return null
  }
}

/**
 * Optimistic: `true` until this process has tried and failed to load the pipeline, and it never
 * attempts a load itself — that is `embedText`'s job. There is no native binary to probe for, and
 * Node caches a failed dynamic `import()` for the life of the process, so a failure stands until a
 * restart.
 */
export function isEmbeddingAvailable(): boolean {
  return !loadFailed
}

/**
 * Separate from `embedText` so a test can drive it with a stubbed `extract`, without the real
 * package or its model download. `text` is not truncated to the model's max token count here: the
 * pipeline's tokenizer already truncates unconditionally.
 */
export async function extractEmbedding(
  text: string,
  extract: FeatureExtractor
): Promise<number[] | null> {
  try {
    const output = await extract(text, { pooling: 'mean', normalize: true })
    return Array.from(output.data)
  } catch (err: any) {
    CARDINAL.logger.warn('search', 'could not embed text with the local model', { error: err })
    return null
  }
}

/** Never throws: `null` when the model is unusable on this system or fails on this text. */
export async function embedText(text: string): Promise<number[] | null> {
  const extract = await getExtractor()
  if (!extract) {
    return null
  }
  return extractEmbedding(text, extract)
}
