#!/usr/bin/env bash
# Builds the production image from `dev/build/Dockerfile`, boots it next to a throwaway postgres
# with `security.allowPuppeteerNoSandbox` left at its `base.yml` default (false — sandbox enabled,
# no opt-in fallback), and drives its real REST API through a genuine PDF export to confirm Chromium's
# own process sandbox actually starts inside the container. It builds locally rather than pulling a
# published tag, since the point is testing an image before it is ever published.
#
# On a stock `docker run` (no extra `--security-opt`/`--cap-add`) this FAILS: Chromium's sandbox
# cannot initialize under Docker's own default seccomp profile, and the image carries no setuid
# sandbox helper as a fallback. See docs/decisions/sandboxed-puppeteer-requires-runtime-flags.md,
# and `docs/audits/release-checklist.md` for the concrete operator remedies.
#
# Usage:
#   ./dev/build/verify-sandboxed-puppeteer.sh [--allow-no-sandbox]
#
#   --allow-no-sandbox   Boot with `security.allowPuppeteerNoSandbox: true` instead, to confirm that
#                        documented fallback still works on its own terms. Never the default: the
#                        sandboxed posture is what a fresh install actually ships with.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

ALLOW_NO_SANDBOX=0
for arg in "$@"; do
  case "$arg" in
    --allow-no-sandbox) ALLOW_NO_SANDBOX=1 ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

RUN_ID="$$"
IMAGE_TAG="wiki-verify-sandboxed-puppeteer:${RUN_ID}"
NETWORK_NAME="wiki-verify-net-${RUN_ID}"
DB_CONTAINER="wiki-verify-db-${RUN_ID}"
APP_CONTAINER="wiki-verify-app-${RUN_ID}"
HOST_PORT="${VERIFY_PORT:-38080}"
ADMIN_PASS="verify-$(date +%s)-${RUN_ID}"

if [ "$ALLOW_NO_SANDBOX" = "1" ]; then
  CONFIG_OVERLAY="dev/build/config.verify-allow-no-sandbox.yml"
else
  CONFIG_OVERLAY="dev/build/config.verify.yml"
fi

cleanup() {
  docker rm -f "$APP_CONTAINER" >/dev/null 2>&1 || true
  docker rm -f "$DB_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for req in assets blocks/compiled; do
  if [ ! -d "$req" ]; then
    echo "FAIL: ${req}/ is missing. Build it first:" >&2
    echo "        npm --prefix frontend ci && npm --prefix frontend run build   (writes ./assets)" >&2
    echo "        npm --prefix blocks ci && npm --prefix blocks run build       (writes ./blocks/compiled)" >&2
    exit 1
  fi
done

echo "==> Building ${IMAGE_TAG} from dev/build/Dockerfile ..."
docker build -f dev/build/Dockerfile -t "$IMAGE_TAG" .

echo "==> Starting a throwaway network + postgres ..."
docker network create "$NETWORK_NAME" >/dev/null
docker run --rm -d --name "$DB_CONTAINER" --network "$NETWORK_NAME" \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=wiki postgres:18 >/dev/null

echo "==> Starting the app container (config overlay: ${CONFIG_OVERLAY}) ..."
docker run --rm -d --name "$APP_CONTAINER" --network "$NETWORK_NAME" \
  -p "127.0.0.1:${HOST_PORT}:3000" \
  -v "${REPO_ROOT}/${CONFIG_OVERLAY}:/wiki/$(basename "$CONFIG_OVERLAY"):ro" \
  -e "CONFIG_FILE=$(basename "$CONFIG_OVERLAY")" \
  -e DB_HOST="$DB_CONTAINER" -e DB_PORT=5432 -e DB_USER=postgres -e DB_PASS=postgres -e DB_NAME=wiki \
  -e ADMIN_EMAIL=admin@example.com -e ADMIN_PASS="$ADMIN_PASS" \
  "$IMAGE_TAG" >/dev/null

echo "==> Waiting for /_ready ..."
DEADLINE=$((SECONDS + 60))
until curl -fsS "http://127.0.0.1:${HOST_PORT}/_ready" >/dev/null 2>&1; do
  if [ "$SECONDS" -ge "$DEADLINE" ]; then
    echo "FAIL: /_ready did not respond within 60s. Container logs:" >&2
    docker logs "$APP_CONTAINER" >&2 || true
    exit 1
  fi
  sleep 2
done

echo "==> Running the application-level verification ..."
STATUS=0
ADMIN_PASS="$ADMIN_PASS" node dev/build/verify-sandboxed-puppeteer.mjs "http://127.0.0.1:${HOST_PORT}" || STATUS=$?

if [ "$STATUS" != "0" ]; then
  echo "---- container logs (tail) ----" >&2
  docker logs "$APP_CONTAINER" 2>&1 | tail -80 >&2
  echo "FAIL: sandboxed Puppeteer verification failed. See docs/decisions/ for the known cause and remedy." >&2
  exit "$STATUS"
fi

echo "PASS: PDF export succeeded with security.allowPuppeteerNoSandbox left at its default."
