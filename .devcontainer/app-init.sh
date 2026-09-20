#!/bin/bash
set -euo pipefail

cd /workspace

echo "Disabling git info in terminal..."
git config codespaces-theme.hide-status 1
git config devcontainers-theme.hide-status 1
git config oh-my-zsh.hide-info 1

echo "Waiting for DB container to come online..."
/usr/local/bin/wait-for localhost:5432 -- echo "DB ready"

echo "Waiting for MinIO container to come online..."
/usr/local/bin/wait-for localhost:9000 -- echo "MinIO ready"

# `npm ci`, not `npm install`, because CI runs `npm ci`: it installs exactly what the lockfile says
# and fails on a lockfile that has drifted from its package.json. Use `npm install` by hand when
# deliberately adding or updating a dependency.
echo "Installing backend dependencies..."
cd /workspace/backend
npm ci

echo "Installing frontend dependencies..."
cd /workspace/frontend
npm ci

echo "Installing blocks dependencies..."
cd /workspace/blocks
npm ci
npm run build

# No browser install for e2e/ or frontend/: Playwright's Chromium is baked into the image (the
# Dockerfile's PLAYWRIGHT_BROWSERS_PATH).
echo "Installing e2e dependencies..."
cd /workspace/e2e
npm ci

cd /workspace

echo "Ready!"
echo
echo "  The e2e suite additionally needs a built frontend in assets/ (npm run build in frontend/),"
echo "  which is deliberately not done here -- it is slow, and the normal dev loop uses npm run dev."
