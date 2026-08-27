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

# Chromium's own process sandbox (see backend/helpers/puppeteer.ts) needs either the setuid sandbox
# helper or unprivileged user namespaces to start. This image relies on the *host's* kernel allowing
# unprivileged user namespace creation (Linux's `kernel.unprivileged_userns_clone` /
# `kernel.apparmor_restrict_unprivileged_userns` sysctls -- the default on most distributions, but
# disabled by some hardened ones and by Docker's default seccomp profile on older engines) rather than
# installing the setuid helper here, so no extra root-owned binary/capability is added to the image on
# top of the existing `USER node`. An operator whose container runtime blocks unprivileged user
# namespaces should instead fall back to an unsandboxed launch (a config-driven opt-in, tracked
# separately -- see backend/helpers/puppeteer.ts) and record that choice in docs/variances.md, rather
# than expect the sandbox to start here.

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

VOLUME ["/wiki/data/content"]

EXPOSE 3000
EXPOSE 3443

CMD ["node", "backend"]
