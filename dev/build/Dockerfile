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
RUN mkdir -p /wiki && \
    mkdir -p /logs && \
    mkdir -p /wiki/data/content && \
    chown -R node:node /wiki /logs

WORKDIR /wiki

COPY --chown=node:node ./assets ./assets
COPY --chown=node:node ./blocks/compiled ./blocks/compiled
COPY --chown=node:node ./backend ./backend
COPY --chown=node:node ./dev/build/config.yml ./config.yml
COPY --chown=node:node ./LICENSE ./LICENSE

USER node

ENV NODE_ENV=production

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

VOLUME ["/wiki/data/content"]

EXPOSE 3000
EXPOSE 3443

CMD ["node", "backend"]
