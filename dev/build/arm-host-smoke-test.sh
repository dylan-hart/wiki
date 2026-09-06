#!/usr/bin/env bash
# Confirms a published Cardinal.js 3.x image actually RUNS correctly on a real arm64 host, not merely
# that its manifest lists linux/arm64 (that half is `backend/scripts/verify-arm64-manifest.ts`, run
# from anywhere, no arm64 hardware needed). This script is the other half of OpenProject #2488
# ("Verify published multi-arch manifest on a real ARM host") and must be run ON a genuine arm64
# machine — a Raspberry Pi 4/5, an arm64 cloud VM, or Apple Silicon's own arm64 Docker Desktop VM —
# not under QEMU emulation, which would defeat the point: QEMU can make an amd64 image "run" on
# arm64 (slowly, emulated) and would silently pass even if the pushed arm64-native layer is broken.
# See docs/release-checklist.md for where this fits in the release runbook.
#
# Usage:
#   ./dev/build/arm-host-smoke-test.sh ghcr.io/<owner>/<repo>:<version>
set -euo pipefail

IMAGE_REF="${1:?Usage: $0 <image-ref>}"
CONTAINER_NAME="wiki-arm-smoke-test-$$"
READY_TIMEOUT_SECONDS=60

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Pulling $IMAGE_REF (letting the daemon pick the native platform)..."
docker pull "$IMAGE_REF"

echo "==> Confirming the pulled image is genuinely arm64, not emulated..."
ACTUAL_ARCH="$(docker inspect --format '{{.Architecture}}' "$IMAGE_REF")"
if [ "$ACTUAL_ARCH" != "arm64" ]; then
  echo "FAIL: docker inspect reports architecture '$ACTUAL_ARCH', expected 'arm64'." >&2
  echo "      Either this host is not actually arm64, or the daemon pulled the wrong platform." >&2
  exit 1
fi
echo "    OK: image architecture is arm64."

echo "==> Starting the container..."
docker run --rm -d --name "$CONTAINER_NAME" -p 127.0.0.1:0:3000 "$IMAGE_REF" >/dev/null

HOST_PORT="$(docker inspect --format '{{(index (index .NetworkSettings.Ports "3000/tcp") 0).HostPort}}' "$CONTAINER_NAME")"

echo "==> Polling http://127.0.0.1:${HOST_PORT}/_ready (up to ${READY_TIMEOUT_SECONDS}s)..."
DEADLINE=$((SECONDS + READY_TIMEOUT_SECONDS))
until curl -fsS "http://127.0.0.1:${HOST_PORT}/_ready" >/dev/null 2>&1; do
  if [ "$SECONDS" -ge "$DEADLINE" ]; then
    echo "FAIL: /_ready did not respond within ${READY_TIMEOUT_SECONDS}s. Container logs:" >&2
    docker logs "$CONTAINER_NAME" >&2 || true
    exit 1
  fi
  sleep 2
done

echo "PASS: $IMAGE_REF is arm64-native and became ready on a real arm64 host."
