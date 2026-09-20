#!/usr/bin/env bash
#
# Clone-to-running setup for the non-devcontainer path: four independently-installed workspaces and
# no root package, so a fresh clone otherwise means four `npm install`s, a config copy and two builds
# by hand -- the sequence `.devcontainer/app-init.sh` hard-codes for the container path.
#
# Safe to re-run: the installs and builds are idempotent, and an existing config.yml is left alone.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Installing backend dependencies"
(cd backend && npm install)

echo "==> Installing frontend dependencies"
(cd frontend && npm install)

echo "==> Installing blocks dependencies"
(cd blocks && npm install)

echo "==> Installing e2e dependencies"
(cd e2e && npm install)

if [ -f "config.yml" ]; then
  echo "==> config.yml already exists, leaving it alone"
else
  echo "==> Creating config.yml from config.sample.yml"
  cp config.sample.yml config.yml
fi

echo "==> Building frontend"
(cd frontend && npm run build)

echo "==> Building blocks"
(cd blocks && npm run build)

echo "==> Done. Edit config.yml with your database details, then run: node backend"
