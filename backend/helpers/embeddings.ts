/**
 * Local embedding model integration
 *
 * A single seam over `@huggingface/transformers` (pure JS/WASM, ONNX inference — no Python, no
 * native compile step; the actively-maintained successor to `@xenova/transformers`, which the
 * project itself moved on from after 2024 — see OpenProject #3149), lazily running
 * `Xenova/all-MiniLM-L6-v2` to turn page text into a 384-dimension sentence embedding for semantic
 * search (Epic #3050). The legacy `Xenova/*` model id stays valid on the new package — Hugging
 * Face's v3 migration notes document ONNX models published under the old org as unchanged and
 * loadable as-is. Mirrors `helpers/images.ts`'s Sharp pattern: a lazy dynamic import by specifier
 * (so the type checker never has to resolve it), a load failure recorded on
 * `CARDINAL.models.extensions` and logged, and `null` returned rather than thrown so a caller degrades
 * gracefully instead of crashing a page save or a search request.
 *
 * Unlike Sharp, there is no native binary and therefore no per-platform compatibility matrix to
 * consult before attempting a load — `isEmbeddingAvailable()` is optimistic (`true`) until this
 * process has actually tried and failed once. That mirrors `models/extensions.ts#hasLoadFailed`'s
 * own reasoning: Node caches a failed dynamic `import()` for the life of the process, so even a
 * fixed environment needs a restart to be believed again either way.
 *
 * A real embedding call downloads and caches the model's ONNX weights (~90MB) from the Hugging Face
 * hub on first use per process — this module does not configure an offline/pre-seeded cache path,
 * which is left to deployment/ops. Nothing here reaches out for anything else: once loaded, inference
 * is entirely local, no external API call, no per-page cost, matching the Epic's offline-capable
 * design decision.
 *
 * Manual verification (not part of the default suite — the model download makes it unsuitable for a
 * fast, offline-safe run): `node -e "const { embedText } = await import('./helpers/embeddings.ts');
 * console.log((await embedText('hello world'))?.length)"` from `backend/`, expecting `384`.
 */

/** The model's own output dimension — `pageEmbeddingChunks.embedding`'s `vector(384)` column matches this. */
export const EMBEDDING_DIMENSIONS = 384

/** The Hugging Face model id `embedText` loads, run through `@huggingface/transformers`. */
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2'

/** The npm specifier, held in a variable so a literal `import '@huggingface/transformers'` never has
 * to resolve at typecheck time — matching `helpers/images.ts`/`helpers/puppeteer.ts`'s convention for
 * an optionally-unusable runtime dependency. */
const specifier = '@huggingface/transformers'

/**
 * The narrow slice of `@huggingface/transformers`'s `FeatureExtractionPipeline` this module actually
 * calls: a text in, a pooled/normalized tensor out. Kept untyped beyond this shape (the package's
 * own types are not imported) since the module itself is loaded dynamically by specifier.
 */
export type FeatureExtractor = (
  text: string,
  options: { pooling: 'mean'; normalize: boolean }
) => Promise<{ data: ArrayLike<number> }>

/** The lazily-created, process-wide singleton pipeline — loaded once, reused by every `embedText` call. */
let extractorPromise: Promise<FeatureExtractor> | null = null

/** Whether this process has already tried and failed to load the pipeline once. See the module doc
 * comment for why this makes `isEmbeddingAvailable()` sound even without re-probing anything. */
let loadFailed = false

/**
 * Load (or reuse) the feature-extraction pipeline, once per process.
 *
 * Load and run are kept apart deliberately, the same way `helpers/images.ts`'s `normalizeImage` keeps
 * loading Sharp apart from running it: only a load failure means the runtime itself is unusable here,
 * and only a load failure should record one and cost `isEmbeddingAvailable()` its optimism for the
 * rest of the process.
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
    // -> The warn log fires first and `noteLoadFailure` is optional-chained: this call runs on a
    //    worker thread (`backend/worker.ts`), whose deliberately minimal `CARDINAL.models` can omit
    //    `extensions` again in the future, and recording the failure must never be able to defeat
    //    this function's own "never throws" contract by throwing before the real error is even
    //    logged (OpenProject #3295).
    CARDINAL.logger.warn('search', 'could not load the local embedding model', { error: err })
    CARDINAL.models.extensions?.noteLoadFailure(specifier)
    return null
  }
}

/**
 * Whether the local embedding model can plausibly be used right now.
 *
 * Synchronous and optimistic: it reports `true` unless this process has already tried and failed to
 * load the pipeline, rather than re-probing `node_modules` or attempting a load itself — an actual
 * load is `embedText`'s job, and doing it here would contradict "importing this module does not
 * itself trigger a model load."
 */
export function isEmbeddingAvailable(): boolean {
  return !loadFailed
}

/**
 * Run already-loaded text through the pipeline and shape its output as a plain embedding vector.
 *
 * Broken out from `embedText` — the same way `helpers/puppeteer.ts#launchUnderSemaphore` is broken
 * out from `launchPuppeteerBrowser` — purely so a test can drive this with a stubbed `extract`
 * function, without needing the real `@huggingface/transformers` package or its model download to
 * exercise the output-shaping and error-handling logic.
 *
 * Truncation to the model's own max token count (256 for MiniLM) is not done here: the pipeline's
 * tokenizer already truncates unconditionally (`truncation: true`, verified against the installed
 * `@huggingface/transformers` pipeline implementation), which is the real safety net regardless of
 * how long `text` is.
 *
 * @returns A 384-length numeric vector, or `null` if running the model on this text failed
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

/**
 * Embed a piece of text with the local model, lazily loading it on first call.
 *
 * @returns A 384-length numeric vector, or `null` if the model is unusable on this system or running
 *          it on this text failed — never throws.
 */
export async function embedText(text: string): Promise<number[] | null> {
  const extract = await getExtractor()
  if (!extract) {
    return null
  }
  return extractEmbedding(text, extract)
}
