/* eslint-disable no-console -- a build-time script: its stdout IS its result, and it runs outside a
   booted `CARDINAL`. */
/*
  Pre-seeds the local embedding model into `@huggingface/transformers`'s own default cache directory
  (`node_modules/@huggingface/transformers/.cache/`, which the package resolves from its own
  `import.meta.url`, not a Cardinal-owned path) at Docker image build time, so an air-gapped
  `offline: true` deployment's semantic search comes up without a first-run Hugging Face Hub fetch.
  Nothing has to detect the pre-seed: the library's own cache-hit resolution finds these files and
  skips the network call the next time `helpers/embeddings.ts#getExtractor` builds the same pipeline.

  Docker-image-only by design — a bare source checkout never runs this and keeps relying on
  `embedText()`'s lazy runtime fetch. Run from `backend/`, after `npm ci` has installed
  `@huggingface/transformers`:

    node scripts/preseed-embedding-model.ts

  `dev/build/verify-embedding-preseed.sh` is the opt-in, not-CI-gated check that the resulting image
  can load this model with zero network access.
*/
import { MODEL_NAME } from '../helpers/embeddings.ts'

/** In a variable, as `helpers/embeddings.ts` holds its own: a literal import specifier would have to
 * resolve at typecheck time, and this only ever runs where the dependency is actually installed. */
const specifier = '@huggingface/transformers'

/** Constructing the pipeline is itself what triggers `@huggingface/transformers`'s
 * download-and-cache-to-disk behavior. */
async function loadRealPipeline(task: string, model: string): Promise<unknown> {
  const { pipeline } = await import(specifier)
  return pipeline(task, model)
}

/**
 * The loader is injectable purely so a test can check the task/model it calls through with, without
 * the real network call and the model download behind it.
 */
export async function preseedModel(
  loadPipeline: (task: string, model: string) => Promise<unknown> = loadRealPipeline
): Promise<void> {
  await loadPipeline('feature-extraction', MODEL_NAME)
}

async function main() {
  console.log(`pre-seeding the local embedding model cache for ${MODEL_NAME}...`)
  try {
    await preseedModel()
  } catch (err: any) {
    console.error(`failed to pre-seed the local embedding model: ${err.message}`)
    process.exit(1)
    return
  }
  console.log('local embedding model cache pre-seeded')
}

// Importing this module (as the test does, for `preseedModel`) must not attempt a real pipeline load
// or exit the process.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
