# Digest-pinned rather than just version-pinned: this is the base of the image
# docker/build-push-action publishes, and a floating tag (even a specific one, since Docker Hub
# repoints "26.x.y-bookworm" itself on a Debian base refresh) means two builds of the same commit
# can start from different base layers with nothing recording which one a published image used.
# Bump alongside the rest of the repo's normal currency pass -- `docker pull node:26-bookworm` then
# `docker inspect --format='{{index .RepoDigests 0}}' node:26-bookworm` gives the new digest.
FROM node:26.7.0-bookworm@sha256:e929171d35b9df7773a3ec5b068e387fa109441dc90f91e6560af5d39b7e9bf1
LABEL maintainer="requarks.io"

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
# The application tree stays root-owned and read-only to the `node` user it runs as. With no build
# step, Node loads `/wiki/backend/**/*.ts` directly on every start, so a writable source tree would
# turn any future arbitrary-write primitive into RCE that survives a restart. Only what `node`
# actually needs to write at runtime is chowned to it: `node_modules` (the two `npm` installs below
# run as `node`) and `/wiki/data` (page/asset storage, cache, and the locale sideload directory --
# everything under `dataPath`). No separate log directory: `core/logger.ts` writes to stdout/stderr
# only, with no file destination -- a 2.x-era leftover, not something this image needs to create or
# own. `node_modules` is created (empty) and chowned *before* `./backend` is copied in, so the copy --
# run as root, since it happens before `USER node` below -- merges into it without touching its
# ownership.
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
# helper or unprivileged user namespaces to start. This image relies on the *host's* kernel allowing
# unprivileged user namespace creation rather than installing the setuid helper here (Debian bookworm's
# `chromium` package ships no such helper to install anyway), so no extra root-owned binary/capability
# is added to the image on top of the existing `USER node`.
#
# CONFIRMED (OpenProject #3214, docs/decisions/sandboxed-puppeteer-requires-runtime-flags.md): a plain
# `docker run` of this image -- no extra flags -- does NOT get there. Docker's own default seccomp
# profile blocks the unprivileged user-namespace creation Chromium's sandbox needs, so every
# headless-browser feature (PDF export, page re-render, diagram render) fails outright until the
# operator either sets `security.allowPuppeteerNoSandbox: true` or starts the container with a
# `--security-opt seccomp=<profile allowing it>` / `--cap-add=SYS_ADMIN`. Run
# `dev/build/verify-sandboxed-puppeteer.sh` against a freshly built image to reproduce or re-check
# this.

# The browser the Puppeteer extension drives, installed above rather than downloaded by Puppeteer: the
# distro keeps it patched, it exists for arm64 as well as amd64, and the image does not carry two copies
# of Chromium. `PUPPETEER_SKIP_DOWNLOAD` has to be set before the install below for that to hold.
#
# This does mean `chromium`'s version here floats with whatever Debian bookworm's apt repo currently
# serves, rather than the Chrome-for-Testing build backend/package.json's `puppeteer` was actually
# developed and pinned against. The two drifting too far apart is a real failure mode, not a
# theoretical one: puppeteer 25.4.0 (pinned to Chrome 151.0.7922.47) against a bookworm chromium that
# had already reached 152.0.7977.75 sent `Page.navigate` calls the newer browser refused outright with
# `net::ERR_INVALID_ARGUMENT` (OpenProject #3256). `backend/package.json`'s `puppeteer` version is kept
# close to whatever this apt package currently resolves to for that reason — see
# `docs/decisions/2026-09-14-puppeteer-chromium-protocol-pin.md` for how that pairing was checked and
# `backend/helpers/puppeteer.ts`'s `launchPuppeteerBrowser` doc comment for the pointer future readers
# will actually land on. A currency pass that bumps `puppeteer` without re-checking this pairing can
# reintroduce the same failure.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /wiki/backend
# Installs the Puppeteer extension too: it is a declared `optionalDependency` of `backend/package.json`
# (alongside Sharp), so `npm ci` resolves it from the same locked, hash-checked tree as everything else
# rather than reaching out to the registry live and unpinned at build time, the way a second, separate
# `npm` command used to. A source checkout that genuinely has no use for a server-side browser -- an
# installation that renders its pages in the editor, which is all of them on any normal save -- can skip
# it by adding `--omit=optional` below (this drops the native Sharp binaries too; see the definition.yml
# comment on that tradeoff). `PUPPETEER_SKIP_DOWNLOAD` above runs before this, so Puppeteer's own
# postinstall never fetches a Chromium build here -- it resolves the distro copy installed above instead.
RUN npm ci --omit=dev

# Pre-seeds the local embedding model (`Xenova/all-MiniLM-L6-v2`) into `@huggingface/transformers`'s
# own default local cache directory at image-build time (OpenProject #3324), so an air-gapped
# `offline: true` deployment's semantic search comes up without a first-run Hugging Face Hub fetch.
# See `backend/scripts/preseed-embedding-model.ts` and `backend/helpers/embeddings.ts`'s module doc
# comment for the full reasoning, and `docs/offline-deployment.md`'s "Pre-seeded local embedding
# model" section for what this does and does not cover. Runs as `node` (already `USER node` above),
# same as the `npm ci` immediately before it, so the cache files land inside `node_modules` -- already
# chowned to `node` near the top of this file -- with no extra permission step needed. A source
# checkout that never runs this Dockerfile is unaffected: `embedText()`'s existing lazy runtime fetch
# is untouched and still runs there exactly as before.
RUN node scripts/preseed-embedding-model.ts

WORKDIR /wiki

# The whole data root, not just `content` -- `dataPath` (`dev/build/config.yml`) is `/wiki/data`, and
# the locale sideload directory (`docs/offline-deployment.md`'s "Locale-pack sideloading") lives at
# `/wiki/data/locales`, a sibling of `content` that a volume scoped to `content` alone would silently
# exclude.
VOLUME ["/wiki/data"]

# Only the plain-HTTP port: Fastify is constructed with no `https` option (`initHTTPServer()`), and
# this image never terminates TLS (`docs/tls-termination.md`) -- a second, higher EXPOSEd port for it
# would advertise a listener that never opens.
EXPOSE 3000

# `/_ready` (registered by `core/http/shutdown.ts#registerProbes`, wired in from `core/http/server.ts`)
# is the same readiness signal a Kubernetes probe would use; a plain Docker deployment gets it too via
# `docker inspect`/`docker ps`.
# --start-period is generous because postBoot() (locale/strategy/site refresh, scheduler start) runs
# after the HTTP server is already listening, so /_ready can otherwise be probed before the instance
# is actually usable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS http://localhost:3000/_ready || exit 1

# --no-experimental-webstorage (OpenProject #3349): lib0 (a transitive dependency of yjs/y-protocols,
# both direct backend deps for collaborative editing) feature-detects the `localStorage` global at
# module load. On Node 26, merely referencing that global -- regardless of whether anything is ever
# stored in it -- fires an `ExperimentalWarning` as a side effect of the property getter itself. The
# backend has no use for `localStorage`/`sessionStorage` of its own, and lib0 already falls back
# correctly to an in-memory polyfill the instant the global is unavailable, so disabling it changes
# nothing observable other than silencing the warning.
CMD ["node", "--no-experimental-webstorage", "backend"]
