FROM node:26
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
# run as `node`), `/wiki/data` (page/asset storage, cache, and the locale sideload directory --
# everything under `dataPath`), and `/logs`. `node_modules` is created (empty) and chowned *before*
# `./backend` is copied in, so the copy -- run as root, since it happens before `USER node` below --
# merges into it without touching its ownership.
RUN mkdir -p /wiki/backend/node_modules /wiki/data /logs && \
    chown -R node:node /wiki/backend/node_modules /wiki/data /logs

WORKDIR /wiki

COPY ./assets ./assets
COPY ./blocks/compiled ./blocks/compiled
COPY ./backend ./backend
COPY ./dev/build/config.yml ./config.yml
COPY ./LICENSE ./LICENSE

USER node

ENV NODE_ENV=production

# The browser the Puppeteer extension drives, installed above rather than downloaded by Puppeteer: the
# distro keeps it patched, it exists for arm64 as well as amd64, and the image does not carry two copies
# of Chromium. `PUPPETEER_SKIP_DOWNLOAD` has to be set before the install below for that to hold.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /wiki/backend
RUN npm ci --omit=dev

# The Puppeteer extension, which server-side page rendering needs. Added here rather than declared in
# `backend/package.json` because it is an optional extension: an installation that renders its pages in
# the editor -- which is all of them, on any normal save -- has no use for a browser on the server, and
# a source checkout should not have to fetch one to install the backend.
#
# The version is read from the extension definition, which is also what the admin area installs when an
# operator adds Puppeteer to an instance by hand: one place to bump, and an image that cannot drift from
# what a hand-installed instance gets. An empty read fails the build rather than quietly installing
# whatever is newest.
RUN PUPPETEER_VERSION="$(sed -n 's/^installVersion: *//p' modules/extensions/puppeteer/definition.yml)" && \
    test -n "$PUPPETEER_VERSION" && \
    npm install --no-save "puppeteer@${PUPPETEER_VERSION}"

WORKDIR /wiki

# The whole data root, not just `content` -- `dataPath` (`dev/build/config.yml`) is `/wiki/data`, and
# the locale sideload directory (`docs/offline-deployment.md`'s "Locale-pack sideloading") lives at
# `/wiki/data/locales`, a sibling of `content` that a volume scoped to `content` alone would silently
# exclude.
VOLUME ["/wiki/data"]

# Only 3000: Fastify is constructed with no `https` option (`initHTTPServer()`), and this image never
# terminates TLS (`docs/tls-termination.md`) -- an `EXPOSE 3443` advertised a port nothing ever opens.
EXPOSE 3000

# `/_ready` (registered by `gracefulServer` in `backend/index.ts`) is the same readiness signal a
# Kubernetes probe would use; a plain Docker deployment gets it too via `docker inspect`/`docker ps`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -fsS http://localhost:3000/_ready || exit 1

CMD ["node", "backend"]
