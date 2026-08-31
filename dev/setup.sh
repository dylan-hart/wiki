#!/usr/bin/env bash
#
# Clone-to-running setup for the non-devcontainer path.
#
# There are four independently-installed workspaces and no root package, so getting a fresh
# clone into a state where `node backend` (from the repo root) serves the built UI otherwise
# means running four `npm install`s, a config copy and two builds by hand -- the same sequence
# `.devcontainer/app-init.sh` already hard-codes for the container path. This does that for
# everyone else.
#
# Safe to re-run: npm install/npm run build are naturally idempotent, and the config.yml copy
# is skipped -- never overwritten -- once the file exists.
#
# Usage: ./dev/setup.sh   (from anywhere -- the repo root is resolved from this script's own
# location, not the caller's working directory)

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
