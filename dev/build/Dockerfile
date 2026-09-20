# Digest-pinned rather than just version-pinned: Docker Hub repoints even a specific
# "26.x.y-bookworm" tag on a Debian base refresh, so two builds of the same commit could otherwise
# start from different base layers with nothing recording which one a published image used. To bump:
# `docker pull node:26-bookworm` then `docker inspect --format='{{index .RepoDigests 0}}'
# node:26-bookworm` gives the new digest.
FROM node:26.7.0-bookworm@sha256:e929171d35b9df7773a3ec5b068e387fa109441dc90f91e6560af5d39b7e9bf1

RUN DEBIAN_FRONTEND=noninteractive apt-get update && apt-get install -qy --no-install-recommends \
    bash \
    build-essential \
    chromium \
    curl \
    fonts-liberation \
    git \
    gnupg \
    openssh-client \
    pandoc \
    && rm -rf /var/lib/apt/lists/*
# The application tree stays root-owned and read-only to the `node` user it runs as: with no build
# step Node loads `/wiki/backend/**/*.ts` directly on every start, so a writable source tree would
# turn any arbitrary-write primitive into RCE that survives a restart. Only what `node` writes at
# runtime is chowned to it -- `node_modules` and `/wiki/data`. `node_modules` is created (empty) and
# chowned *before* `./backend` is copied in, so that copy -- still root, this is above `USER node` --
# merges into it without touching its ownership.
RUN mkdir -p /wiki/backend/node_modules /wiki/data && \
    chown -R node:node /wiki/backend/node_modules /wiki/data

WORKDIR /wiki

COPY ./assets ./assets
COPY ./blocks/compiled ./blocks/compiled
COPY ./backend ./backend
COPY ./dev/build/config.yml ./config.yml
COPY ./LICENSE ./LICENSE

USER node

ENV NODE_ENV=production

# Chromium's own process sandbox (see backend/helpers/puppeteer.ts) needs either the setuid sandbox
# helper or unprivileged user namespaces to start. No setuid helper is installed here -- Debian
# bookworm's `chromium` package ships none to install anyway -- so the image adds no root-owned
# binary or capability on top of `USER node`, and relies on the *host's* kernel allowing
# unprivileged user-namespace creation instead.
#
# A plain `docker run` -- no extra flags -- does NOT get there: Docker's own default seccomp profile
# blocks that user-namespace creation, so every headless-browser feature (PDF export, page
# re-render, diagram render) fails outright until the operator sets
# `security.allowPuppeteerNoSandbox: true` or starts the container with `--security-opt
# seccomp=<profile allowing it>` / `--cap-add=SYS_ADMIN`. See
# docs/decisions/sandboxed-puppeteer-requires-runtime-flags.md;
# `dev/build/verify-sandboxed-puppeteer.sh` re-checks it against a built image.

# The browser the Puppeteer extension drives, installed above rather than downloaded by Puppeteer: the
# distro keeps it patched, it exists for arm64 as well as amd64, and the image does not carry two copies
# of Chromium. `PUPPETEER_SKIP_DOWNLOAD` has to be set before the install below for that to hold.
#
# This does mean `chromium` floats with whatever bookworm's apt repo serves, rather than the
# Chrome-for-Testing build `backend/package.json`'s `puppeteer` is pinned against. Drifting too far
# apart breaks the DevTools protocol between them (a `Page.navigate` the newer browser refuses with
# `net::ERR_INVALID_ARGUMENT`), so a currency pass that bumps `puppeteer` without re-checking that
# pairing reintroduces the failure. See `docs/decisions/2026-09-14-puppeteer-chromium-protocol-pin.md`.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /wiki/backend
# Installs the Puppeteer extension too: it is a declared `optionalDependency` of `backend/package.json`
# (alongside Sharp), so `npm ci` resolves it from the same locked, hash-checked tree as everything else
# rather than reaching out to the registry live and unpinned at build time. An installation with no use
# for a server-side browser can skip it with `--omit=optional` here, which drops the native Sharp
# binaries too. `PUPPETEER_SKIP_DOWNLOAD` above runs before this, so Puppeteer's own postinstall never
# fetches a Chromium build -- it resolves the distro copy installed above instead.
RUN npm ci --omit=dev

# Pre-seeds the local embedding model into `@huggingface/transformers`'s own default cache directory
# at image-build time, so an air-gapped `offline: true` deployment's semantic search comes up without
# a first-run Hugging Face Hub fetch. See `docs/offline-deployment.md`'s "Pre-seeded local embedding
# model" section for what this does and does not cover. Runs as `node` (already `USER node` above),
# so the cache files land inside the `node_modules` chowned to `node` near the top of this file, with
# no extra permission step.
RUN node scripts/preseed-embedding-model.ts

WORKDIR /wiki

# The whole `dataPath` root, not just `content`: the locale sideload directory lives at
# `/wiki/data/locales`, a sibling a volume scoped to `content` alone would silently exclude.
VOLUME ["/wiki/data"]

# Only the plain-HTTP port: this image never terminates TLS (`docs/tls-termination.md`), so a second
# EXPOSEd port for it would advertise a listener that never opens.
EXPOSE 3000

# --start-period is generous because postBoot() (locale/strategy/site refresh, scheduler start) runs
# after the HTTP server is already listening, so /_ready can otherwise be probed before the instance
# is actually usable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS http://localhost:3000/_ready || exit 1

# --no-experimental-webstorage: lib0 (a transitive dependency of yjs/y-protocols) feature-detects the
# `localStorage` global at module load, and on Node 26 merely referencing it fires an
# `ExperimentalWarning` from the property getter itself. The backend has no use for web storage and
# lib0 falls back to an in-memory polyfill when the global is absent, so this only silences noise.
CMD ["node", "--no-experimental-webstorage", "backend"]
