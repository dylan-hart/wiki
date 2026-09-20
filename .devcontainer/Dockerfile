# The CI-parity development image: it is meant to BE what .github/workflows/{quality,build,e2e}.yml
# run on. Anything a workflow step installs onto the runner belongs here too, at the same pinned
# version, or the two drift apart.

# The single declaration of the Node pin in .devcontainer/. An exact patch, not `26` or `26.x`: a
# floating major lets this image and CI resolve different patches on different days.
#
# Bumping it is a three-file change, in one commit: this ARG, NODE_IMAGE_DIGEST below, and every
# `node-version:` in .github/workflows/*.yml.
ARG NODE_VERSION=26.8.1

# Digest of the multi-arch (amd64 + arm64) `node:${NODE_VERSION}-bookworm` index. In the FROM's
# `tag@digest` form the digest is what resolves; the tag only keeps the line readable.
ARG NODE_IMAGE_DIGEST=sha256:9f94d34c787165dca03b74e5bf9c3bf90e8de79b19aa3d87fe1fa1694bf75c89

FROM node:${NODE_VERSION}-bookworm@${NODE_IMAGE_DIGEST}

# An ARG declared before the first FROM is out of scope inside the build stage; re-declaring it
# without a default inherits the value resolved above.
ARG NODE_VERSION

ENV DEBIAN_FRONTEND=noninteractive

EXPOSE 3000

RUN set -eu; \
    actual="$(node -v)"; \
    if [ "$actual" != "v${NODE_VERSION}" ]; then \
      echo "FATAL: NODE_VERSION says v${NODE_VERSION} but the pinned base image runs ${actual}." >&2; \
      echo "       NODE_VERSION and NODE_IMAGE_DIGEST in this Dockerfile have drifted apart." >&2; \
      exit 1; \
    fi; \
    echo "Node pin verified: ${actual}"

# `pandoc` is here for CI parity: backend/models/import.test.ts's real-pandoc test silently skips
# without it.
RUN apt-get update && apt-get install -qy --no-install-recommends \
    bash \
    build-essential \
    curl \
    jq \
    less \
    git \
    gettext \
    gnupg2 \
    libcurl4-openssl-dev \
    libexpat1-dev \
    libssl-dev \
    nano \
    netcat-openbsd \
    pandoc \
    unzip \
    wget \
    zlib1g-dev

# Chromium for Puppeteer (the app's server-side page rendering), from the distro rather than
# Puppeteer's own download: the distro keeps it patched, and it exists for arm64. Deliberately not
# shared with the Playwright browser below, which serves the test suites.
#
# Without recommends, because Chromium recommends a desktop stack (an X server, a terminal
# emulator, usbmuxd) that nothing headless touches. The apt lists from the install above are still
# around, so no second update is needed.
RUN apt-get install -qy --no-install-recommends \
    chromium \
    fonts-liberation

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# git-cliff, pinned to the same release quality.yml installs. A standalone binary, not an npm
# dependency of any workspace: backend/test/changelog.test.ts runs it against the checkout.
ARG GIT_CLIFF_VERSION=2.13.1
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) target='x86_64-unknown-linux-gnu' ;; \
      arm64) target='aarch64-unknown-linux-gnu' ;; \
      *) echo "FATAL: no git-cliff build for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    curl -sSLf "https://github.com/orhun/git-cliff/releases/download/v${GIT_CLIFF_VERSION}/git-cliff-${GIT_CLIFF_VERSION}-${target}.tar.gz" \
      | tar xz --strip-components=1 -C /usr/local/bin "git-cliff-${GIT_CLIFF_VERSION}/git-cliff"; \
    git-cliff --version

# git, built from source at a pinned release: bookworm's apt git is older than the CI runner's.
#
# Not the `ghcr.io/devcontainers/features/git` feature, which builds under /usr/local, whose system
# config is /usr/local/etc/gitconfig -- silently orphaning the `git config --system` settings below,
# written to /etc/gitconfig. `make prefix=/usr` overwrites the apt-installed /usr/bin/git and keeps
# the system config at /etc/gitconfig.
#
# NO_RUST=1: git's Makefile otherwise builds an optional Rust component and fails with
# `cargo: not found`. Nothing here needs it, so the image carries no Rust toolchain.
ARG GIT_VERSION=2.55.0
ARG GIT_SHA256=457fdb04dc8728e007d4688695e6912e6f680727920f2a40bf11eacc17505357
RUN set -eu; \
    curl -sSLf -o /tmp/git.tar.xz "https://mirrors.edge.kernel.org/pub/software/scm/git/git-${GIT_VERSION}.tar.xz"; \
    echo "${GIT_SHA256}  /tmp/git.tar.xz" | sha256sum -c -; \
    mkdir -p /usr/src/git; \
    tar -xJf /tmp/git.tar.xz --strip-components=1 -C /usr/src/git; \
    rm /tmp/git.tar.xz; \
    cd /usr/src/git; \
    make prefix=/usr NO_RUST=1 -j"$(nproc)" all; \
    make prefix=/usr NO_RUST=1 install; \
    cd /; \
    rm -rf /usr/src/git; \
    actual="$(git --version | awk '{print $3}')"; \
    if [ "$actual" != "${GIT_VERSION}" ]; then \
      echo "FATAL: GIT_VERSION says ${GIT_VERSION} but the built binary reports ${actual}." >&2; \
      echo "       GIT_VERSION and GIT_SHA256 in this Dockerfile have drifted apart." >&2; \
      exit 1; \
    fi; \
    echo "git pin verified: ${actual}"

# Playwright's Chromium, for e2e/ and for frontend/'s real-layout describes
# (test/realGridLayout.js), which `hasChromium()` silently SKIPs when no browser is installed.
#
# PLAYWRIGHT_VERSION must track `playwright` in frontend/package.json and `@playwright/test` in
# e2e/package.json: Playwright refuses to launch a browser revision it does not expect.
#
# A shared PLAYWRIGHT_BROWSERS_PATH rather than the default ~/.cache/ms-playwright: this RUN
# executes as root, the container runs as `node`, and a browser in root's home is invisible to it.
ARG PLAYWRIGHT_VERSION=1.62.1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN set -eu; \
    npx --yes "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium; \
    chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"; \
    ls -1 "$PLAYWRIGHT_BROWSERS_PATH"

# An explicit git configuration, so nothing in the container depends on the host's ~/.gitconfig.
#
# `master` is the parity-correct value, not a style preference: a GitHub-hosted runner configures no
# `init.defaultBranch`, so git falls back to its compiled-in `master`. `main` here would let a
# fixture that runs `git init` without --initial-branch pass in this image and fail in CI.
#
# The identity is the inverse trade: a bare runner has none, so a test relying on an ambient
# identity passes here and fails on CI.
#
# safe.directory covers /workspace and everything under it (the `/*` form needs git >= 2.36): the
# bind-mounted repo is owned by the host's uid, which need not match the container user's, and git
# worktrees under the repo are their own top-level directories.
RUN git config --system init.defaultBranch master \
    && git config --system user.name 'Wiki.js Dev Container' \
    && git config --system user.email 'dev-container@js.wiki' \
    && git config --system --add safe.directory /workspace \
    && git config --system --add safe.directory '/workspace/*'

ENV npm_config_loglevel=warn
ENV npm_config_fund=false

# FIXME: colorizes root's prompt, but the image runs as `node` (USER below), whose
# /home/node/.bashrc this never touches.

COPY wait-for.sh /usr/local/bin/wait-for
RUN chmod +rx /usr/local/bin/wait-for

COPY app-init.sh /docker-init.sh
RUN sed -i 's/\r$//' /docker-init.sh && \
    chmod +x /docker-init.sh

# The chown only matters when the image runs standalone: docker-compose.yml's bind mount over
# /workspace takes its ownership from the host side.
RUN mkdir -p /workspace && chown node:node /workspace

# Drop root: every root-only setup step is above this line. `node` (uid/gid 1000) ships with the
# base image and is devcontainer.json's `remoteUser`, so a plain `docker run` gets the same user
# the devcontainer tooling does.
USER node
WORKDIR /workspace

ENV NODE_ENV=development

# The container's default command is `sleep infinity` (docker-compose.yml), so this legitimately
# reports unhealthy until a developer starts the backend inside it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsS http://localhost:3000/_ready || exit 1
