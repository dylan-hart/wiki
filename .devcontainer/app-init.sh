#!/bin/bash
set -euo pipefail

cd /workspace

echo "Disabling git info in terminal..."
git config codespaces-theme.hide-status 1
git config devcontainers-theme.hide-status 1
git config oh-my-zsh.hide-info 1

echo "Waiting for DB container to come online..."
/usr/local/bin/wait-for localhost:5432 -- echo "DB ready"

# `npm ci` rather than `npm install`, in all four workspaces, for the same reason this whole image
# exists: CI runs `npm ci`, so this environment runs `npm ci`. It installs exactly what the lockfile
# says instead of whatever the ranges resolve to this morning, and it fails loudly on a lockfile that
# has drifted out of step with its package.json -- which is a signal worth getting here rather than
# discovering on a red pipeline. Use plain `npm install` by hand when you are deliberately adding or
# updating a dependency.
#
# Puppeteer, which server-side page rendering needs, is a declared `optionalDependencies` entry in
# backend/package.json (OpenProject #2289) -- the install below already fetches it, the same way
# it fetches sharp. No separate install step, and no version to derive from definition.yml, remains
# here: `--omit=optional` is the one escape hatch for a source checkout that wants to skip it.
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

# e2e/ is the fourth workspace and is installed here too, because the Playwright leg is meant to run
# inside this container rather than on a developer's host (Feature #2601). Its browser is already in
# the image -- see the Dockerfile's PLAYWRIGHT_BROWSERS_PATH block -- so neither this workspace nor
# frontend/ needs the per-machine `npm run install-browsers` step CLAUDE.md used to require.
echo "Installing e2e dependencies..."
cd /workspace/e2e
npm ci

cd /workspace

echo "Ready!"
echo
echo "  The e2e suite additionally needs a built frontend in assets/ (npm run build in frontend/),"
echo "  which is deliberately not done here -- it is slow, and the normal dev loop uses npm run dev."
