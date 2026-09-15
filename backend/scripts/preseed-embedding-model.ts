/* eslint-disable no-console -- a build-time script: its stdout IS its result, and it runs outside a
   booted `CARDINAL`. */
/*
  Pre-seeds the local embedding model into `@huggingface/transformers`'s own default local cache
  directory (`node_modules/@huggingface/transformers/.cache/`, resolved by the package itself from
  its own `import.meta.url` — verified against the installed package, not a Cardinal-owned path) at
  Docker image build time (`dev/build/Dockerfile`, OpenProject #3324), so a genuinely air-gapped
  `offline: true` deployment's semantic search comes up without a first-run Hugging Face Hub fetch.

  No code change was needed in `helpers/embeddings.ts` to detect "pre-seeded" — the library's own
  cache-hit/cache-miss resolution finds these files and skips the network call automatically the next
  time something constructs this same pipeline (`helpers/embeddings.ts#getExtractor`). This script
  just runs that same construction once, early, so the download happens at build time instead of on
  an operator's first real request.

  Deliberately Docker-image-only, per the work package's resolved scope: a bare source checkout
  (`npm install` / `npm run start`, not built from `dev/build/Dockerfile`) never runs this script and
  keeps relying on `embedText()`'s existing lazy runtime fetch, exactly as before this script existed.

  Run from `backend/`, after `npm ci` has installed `@huggingface/transformers`:

    node scripts/preseed-embedding-model.ts

  `dev/build/verify-embedding-preseed.sh` is the opt-in, not-CI-gated check that the resulting image
  can actually load this model with zero network access.
*/
import { MODEL_NAME } from '../helpers/embeddings.ts'

/** The npm specifier, held in a variable for the same reason `helpers/embeddings.ts` holds its own:
 * a literal `import '@huggingface/transformers'` would have to resolve at typecheck time, and this
 * script — like that module — is only ever meant to run where the (non-optional) dependency is
 * actually installed. */
const specifier = '@huggingface/transformers'

/** The default real loader: a dynamic import by specifier, then the same `pipeline()` call
 * `helpers/embeddings.ts#getExtractor` makes. Constructing the pipeline is what actually triggers
 * `@huggingface/transformers`'s download-and-cache-to-disk behavior. */
async function loadRealPipeline(task: string, model: string): Promise<unknown> {
  const { pipeline } = await import(specifier)
  return pipeline(task, model)
}

/**
 * Pre-seeds the model by loading its pipeline once. Broken out from `main()`, with an injectable
 * loader, purely so a test can verify this calls through with the right task/model without a real
 * network call or the ~90MB download it would trigger — the same seam
 * `helpers/embeddings.ts#extractEmbedding` uses for its own tests.
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

// Only run when executed directly — importing this module (as the test file does, for `preseedModel`)
// must not attempt a real pipeline load or call `process.exitCode`.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
