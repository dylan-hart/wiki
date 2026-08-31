#!/bin/bash

cd /workspace

echo "Disabling git info in terminal..."
git config codespaces-theme.hide-status 1
git config devcontainers-theme.hide-status 1
git config oh-my-zsh.hide-info 1

echo "Waiting for DB container to come online..."
/usr/local/bin/wait-for localhost:5432 -- echo "DB ready"

echo "Installing dependencies..."
cd backend
npm install

# Puppeteer, which server-side page rendering needs, is a declared `optionalDependencies` entry in
# backend/package.json (OpenProject #2289) -- the `npm install` above already fetches it, the same way
# it fetches sharp. No separate install step, and no version to derive from definition.yml, remains
# here: `--omit=optional` is the one escape hatch for a source checkout that wants to skip it.
cd ../frontend
npm install
cd ../blocks
npm install
npm run build
cd ..

echo "Ready!"
