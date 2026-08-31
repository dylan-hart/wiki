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
# unprivileged user namespace creation (Linux's `kernel.unprivileged_userns_clone` /
# `kernel.apparmor_restrict_unprivileged_userns` sysctls -- the default on most distributions, but
# disabled by some hardened ones and by Docker's default seccomp profile on older engines) rather than
# installing the setuid helper here, so no extra root-owned binary/capability is added to the image on
# top of the existing `USER node`. An operator whose container runtime blocks unprivileged user
# namespaces should instead opt into `security.allowPuppeteerNoSandbox` and record that in
# docs/variances.md, rather than expect the sandbox to start here.

# The browser the Puppeteer extension drives, installed above rather than downloaded by Puppeteer: the
# distro keeps it patched, it exists for arm64 as well as amd64, and the image does not carry two copies
# of Chromium. `PUPPETEER_SKIP_DOWNLOAD` has to be set before the install below for that to hold.
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

# `/_ready` (registered by `gracefulServer` in `backend/index.ts`) is the same readiness signal a
# Kubernetes probe would use; a plain Docker deployment gets it too via `docker inspect`/`docker ps`.
# --start-period is generous because postBoot() (locale/strategy/site refresh, scheduler start) runs
# after the HTTP server is already listening, so /_ready can otherwise be probed before the instance
# is actually usable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS http://localhost:3000/_ready || exit 1

CMD ["node", "backend"]
