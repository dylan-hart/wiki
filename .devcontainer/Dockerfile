# The CI-parity development image (OpenProject #2684, under Feature #2601).
#
# This image is not "a development environment that resembles CI" -- it is meant to BE what
# .github/workflows/{quality,build,e2e}.yml run on, so that "it passes for me" and "it passes in CI"
# are the same statement. Everything a workflow step installs onto the runner before it can run the
# gate is therefore installed here too, at the same pinned version:
#
#   | What CI installs                          | Where                              | Here          |
#   | ----------------------------------------- | ---------------------------------- | ------------- |
#   | Node (setup-node `node-version: 26.x`)    | all four workflows                 | NODE_VERSION  |
#   | postgres:18                               | quality.yml / build.yml / e2e.yml  | docker-compose|
#   | pandoc                                    | quality.yml                        | apt, below    |
#   | git-cliff, pinned                         | quality.yml                        | GIT_CLIFF_... |
#   | Playwright's chromium (`--with-deps`)     | quality.yml / build.yml / e2e.yml  | PLAYWRIGHT_...|
#
# Anything added to a workflow's install steps belongs here as well, or the two drift apart again --
# which is the whole defect class Feature #2601 exists to close.

# ---------------------------------------------------------------------------------------------
# THE PINNED NODE PATCH. This ARG is the single declaration of it anywhere in .devcontainer/ --
# docker-compose.yml passes it through rather than naming a version of its own, and devcontainer.json
# no longer layers the `devcontainers/features/node` feature on top (that feature installed a SECOND,
# nvm-managed Node over this one, so the image's Node was never the one you got).
#
# 26.8.1 is what `node-version: 26.x` resolved to on 2026-09-06, read from the manifest setup-node
# itself resolves against (actions/node-versions' versions-manifest.json); nodejs.org/dist agrees
# (26.8.1, released 2026-08-26). It is deliberately an exact patch and not `26` or `26.x`: a floating
# major lets this image and CI resolve different patches on different days, which is this Feature's
# own problem reintroduced one level down, and CLAUDE.md's Currency rule already forbids it.
#
# Bumping it is a three-file change, not a one-line edit: this ARG, NODE_IMAGE_DIGEST below, and
# every `node-version:` in .github/workflows/*.yml -- together, in one commit. The RUN assertion
# further down fails the build if the ARG and the digest ever disagree.
# ---------------------------------------------------------------------------------------------
ARG NODE_VERSION=26.8.1

# Digest of `node:26.8.1-bookworm` (a multi-arch index: amd64 and arm64, so this builds natively on
# Apple Silicon with no -bullseye escape hatch). Digest-pinned for the same reason as
# dev/build/Dockerfile's base image -- see its comment. Bump alongside that file's pin during the
# normal currency pass; the two need not match a commit apart (this is dev tooling, that one is what
# gets published) but should stay close.
#
# The tag is kept next to the digest on purpose: the digest is what actually resolves, the tag is
# what makes the line readable and greppable.
ARG NODE_IMAGE_DIGEST=sha256:9f94d34c787165dca03b74e5bf9c3bf90e8de79b19aa3d87fe1fa1694bf75c89

FROM node:${NODE_VERSION}-bookworm@${NODE_IMAGE_DIGEST}

# An ARG declared before the first FROM is out of scope inside the build stage; re-declaring it here
# (with no default) inherits the value resolved above.
ARG NODE_VERSION

ENV DEBIAN_FRONTEND=noninteractive

EXPOSE 3000

# The pin is only worth having if it is true. A digest and a tag can disagree -- someone bumps
# NODE_VERSION and forgets NODE_IMAGE_DIGEST, and the image silently keeps the old runtime while
# every comment and every workflow claims the new one. Fail the build instead.
RUN set -eu; \
    actual="$(node -v)"; \
    if [ "$actual" != "v${NODE_VERSION}" ]; then \
      echo "FATAL: NODE_VERSION says v${NODE_VERSION} but the pinned base image runs ${actual}." >&2; \
      echo "       NODE_VERSION and NODE_IMAGE_DIGEST in this Dockerfile have drifted apart." >&2; \
      exit 1; \
    fi; \
    echo "Node pin verified: ${actual}"

# Install the packages we need.
#
# `pandoc` is here for CI parity specifically: quality.yml installs it because
# backend/models/import.test.ts's real-pandoc test is gated on `pandocAvailable` and silently skips
# without it -- a suite that skips locally and runs in CI is exactly the asymmetry this image closes.
RUN apt-get update && apt-get install -qy \
    bash \
    build-essential \
    curl \
    jq \
    less \
    git \
    gnupg2 \
    nano \
    netcat-openbsd \
    pandoc \
    unzip \
    wget

# Chromium, for the Puppeteer extension. Rendering a page on the server means driving a headless
# browser, and this is the copy Puppeteer is pointed at rather than one it downloads for itself:
# the distro keeps it patched, and it exists for arm64 as well as amd64. This is a DIFFERENT browser
# from the Playwright one installed below -- Puppeteer serves the app's own server-side rendering,
# Playwright serves the test suites -- and they are deliberately not shared.
#
# Its own RUN, and without recommends, because Chromium recommends a desktop stack -- an X server, a
# terminal emulator, usbmuxd -- that takes the package count from 61 to 177 and that nothing headless
# ever touches. The apt lists from the install above are still around, so no second update is needed.
RUN apt-get install -qy --no-install-recommends \
    chromium \
    fonts-liberation

# Where Puppeteer looks for a browser, and that it must not fetch a second one on install
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# ---------------------------------------------------------------------------------------------
# git-cliff, pinned to the same release quality.yml installs.
#
# It is a standalone binary, not an npm dependency of any workspace (see
# backend/test/changelog.test.ts's header comment and docs/versioning.md), and that suite runs
# `git-cliff --unreleased` against the checkout's own history. Without the binary the suite fails
# here while passing in CI.
#
# Arch-aware because this image is built natively on both amd64 and arm64; a hard-coded x86_64
# tarball would install a binary that cannot execute on an Apple Silicon host.
# ---------------------------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------------------------
# Playwright's Chromium, at the revision the `playwright` package expects.
#
# Two suites need it, and CI installs it for both: e2e/'s whole Playwright suite, and frontend/'s two
# "real layout" describes (test/realGridLayout.js -- neither jsdom nor happy-dom runs a layout
# engine, so a CSS Grid column count can only be measured in a real browser). frontend/'s
# `hasChromium()` probe makes those describes SKIP when no browser is installed, so without this the
# container quietly runs fewer tests than CI does and reports green.
#
# PLAYWRIGHT_VERSION must track `playwright` in frontend/package.json and `@playwright/test` in
# e2e/package.json -- all three are 1.62.1 today. Bumping either package without rebuilding this
# image leaves a browser revision Playwright refuses to launch; the literal lives here so the
# coupling is visible at the point of change.
#
# Installed to a shared PLAYWRIGHT_BROWSERS_PATH rather than the default per-user
# ~/.cache/ms-playwright: this RUN executes as root, but the container runs as `node`, and a browser
# in root's home is invisible to it. `chmod a+rX` makes it readable by whichever user ends up
# running the suites.
# ---------------------------------------------------------------------------------------------
ARG PLAYWRIGHT_VERSION=1.62.1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN set -eu; \
    npx --yes "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium; \
    chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"; \
    ls -1 "$PLAYWRIGHT_BROWSERS_PATH"

# ---------------------------------------------------------------------------------------------
# An explicit git configuration, so nothing in the container depends on the host's ~/.gitconfig.
#
# This is not tidiness: Bug #2586 was caused by exactly that ambient dependency. A test fixture ran
# `git init` with no --initial-branch and then pushed `main`; the developer's machine had
# `init.defaultBranch=main` configured and CI's did not, so the suite passed locally and failed in CI
# for fifteen subtests at once, and the bug could not be reproduced on the machine that wrote it.
#
# `master` is deliberate and is the parity-correct value, not a style preference. A GitHub-hosted
# runner configures no `init.defaultBranch` at all, so git falls back to its own compiled-in default,
# which is `master`. Pinning this image to `main` instead would make a #2586-shaped defect pass here
# and fail there -- the precise drift this image exists to eliminate. If GitHub's runner image is
# ever found to set one, THIS is the line to change.
#
# The identity is the inverse trade, and worth stating plainly: a bare runner has no global
# user.name/user.email either, so setting one here is a deliberate divergence rather than parity. It
# is what this WP asks for (an explicit identity rather than an inherited one) and it makes the
# container deterministic; the residual gap is that a test relying on an ambient identity would pass
# here and fail on CI. Nothing known does -- the git storage module sets its own per-repo identity in
# modules/storage/git/repo.ts#ensureRepo -- but the gap is real and is not claimed to be closed.
#
# safe.directory covers /workspace and everything under it (the trailing /* form, git >= 2.36),
# because the bind-mounted repo is owned by the host's uid, which need not match the container user's
# on a Linux host, and because git worktrees under the repo are their own top-level directories.
#
# This writes /etc/gitconfig, the system config of the distro git installed above. It is also why
# devcontainer.json no longer enables the `devcontainers/features/git` feature: that feature builds
# git from source under /usr/local, whose system config is /usr/local/etc/gitconfig -- so every
# setting below would still be on disk and silently no longer read. See docs/variances.md for the
# resulting git-version divergence from ubuntu-latest, which is accepted rather than hidden.
# ---------------------------------------------------------------------------------------------
RUN git config --system init.defaultBranch master \
    && git config --system user.name 'Wiki.js Dev Container' \
    && git config --system user.email 'dev-container@js.wiki' \
    && git config --system --add safe.directory /workspace \
    && git config --system --add safe.directory '/workspace/*'

# avoid million NPM install messages
ENV npm_config_loglevel=warn
# disable NPM funding messages
ENV npm_config_fund=false

# Colorize the bash shell
RUN sed -i 's/#force_color_prompt=/force_color_prompt=/' /root/.bashrc

# Copy wait-for utility
COPY wait-for.sh /usr/local/bin/wait-for
RUN chmod +rx /usr/local/bin/wait-for

# Copy the startup file
COPY app-init.sh /docker-init.sh
RUN sed -i 's/\r$//' /docker-init.sh && \
    chmod +x /docker-init.sh

# Create workspace
RUN mkdir -p /workspace
WORKDIR /workspace

ENV NODE_ENV=development
