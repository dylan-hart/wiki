#!/usr/bin/env bash
# Builds the production image from `dev/build/Dockerfile` and confirms the local embedding model
# `backend/scripts/preseed-embedding-model.ts` bakes in at build time actually loads with ZERO
# network access from inside a throwaway container, rather than assuming it from "the build step ran
# without erroring."
#
# Deliberately narrower than `dev/build/verify-sandboxed-puppeteer.sh`: no Postgres, no full app
# boot, no `/_ready` poll. Loading the embedding pipeline needs neither -- it is pure local ONNX
# inference once the cache is warm -- so producing an embedding under `--network none` can only
# succeed by reading files already on disk.
#
# `CARDINAL.capabilities.semanticSearch` (`backend/core/pgvectorBootstrap.ts`) is pgvector-only and
# independent of this model, so it is deliberately not what this checks.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

for req in assets blocks/compiled; do
  if [ ! -d "$req" ]; then
    echo "FAIL: ${req}/ is missing. Build it first:" >&2
    echo "        npm --prefix frontend ci && npm --prefix frontend run build   (writes ./assets)" >&2
    echo "        npm --prefix blocks ci && npm --prefix blocks run build       (writes ./blocks/compiled)" >&2
    exit 1
  fi
done

RUN_ID="$$"
IMAGE_TAG="wiki-verify-embedding-preseed:${RUN_ID}"

cleanup() {
  docker rmi -f "$IMAGE_TAG" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Building ${IMAGE_TAG} from dev/build/Dockerfile ..."
docker build -f dev/build/Dockerfile -t "$IMAGE_TAG" .

echo "==> Confirming the pre-seeded cache files exist in the built image ..."
if ! docker run --rm "$IMAGE_TAG" sh -c 'find backend/node_modules/@huggingface/transformers/.cache -type f 2>/dev/null | head -1' | grep -q .; then
  echo "FAIL: no files found under backend/node_modules/@huggingface/transformers/.cache -- the pre-seed step did not bake anything in." >&2
  exit 1
fi

echo "==> Loading the embedding pipeline with --network none (zero outbound access) ..."
OUTPUT="$(docker run --rm --network none "$IMAGE_TAG" \
  node -e "
    // A minimal CARDINAL global, the same shape backend/worker.ts installs for a worker thread --
    // embedText()'s success path never touches it, but a real failure inside it should surface its
    // own message here rather than a ReferenceError masking what actually went wrong.
    globalThis.CARDINAL = { logger: { warn: (...args) => console.error('warn:', ...args) }, models: {} }
    import('./backend/helpers/embeddings.ts').then(async ({ embedText }) => {
      const vector = await embedText('offline verification probe')
      if (!vector) {
        console.error('embedText returned null -- the pipeline did not load from the pre-seeded cache')
        process.exit(1)
      }
      console.log('EMBEDDING_LENGTH=' + vector.length)
    }).catch((err) => {
      console.error('embedText threw: ' + err.message)
      process.exit(1)
    })
  " 2>&1)" || {
  echo "FAIL: embedding pipeline could not load with no network access. Output:" >&2
  echo "$OUTPUT" >&2
  exit 1
}

echo "$OUTPUT"
if ! echo "$OUTPUT" | grep -q "^EMBEDDING_LENGTH=384$"; then
  echo "FAIL: did not observe a 384-length embedding with no network access. Output above." >&2
  exit 1
fi

echo "PASS: the pre-seeded embedding model loaded and produced a real embedding with --network none."
