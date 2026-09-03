# `backend/` native dependencies under `linux/arm64` (OpenProject #2485)

Findings for OpenProject #2485, "Verify native dependencies build correctly under QEMU arm64
emulation", part of Epic #2435's scope (adding `linux/arm64` to `.github/workflows/build.yml` and
`release.yml`'s Docker Buildx build, ahead of #2486/#2487). This is a **verification/audit task**,
not a feature — the deliverable is this write-up plus the regression guard at
`backend/test/arm64NativeDeps.test.ts`, which pins the structural facts this audit found so a
future dependency bump can't silently regress them unnoticed.

## Method, and a real limitation of the environment this audit ran in

The intended verification was an actual `docker buildx build --platform linux/arm64` of
`dev/build/Dockerfile`, mirroring what CI's QEMU-emulated arm64 leg will do. **That could not be
completed**: this environment's Docker credential helper (`credsStore: "desktop"`) requires macOS
Keychain access, and the session it ran in does not allow interactive Keychain access —
`docker pull`/`docker buildx build` both fail immediately with `error getting credentials … keychain
cannot be accessed because the current session does not allow user interaction`, even against a
config with no stored credentials at all (verified with an alternate `DOCKER_CONFIG` carrying an
empty `auths`). This blocks pulling `node:26.7.0-bookworm` (or any other image) from Docker Hub
entirely in this environment, regardless of platform.

Two more things worth being precise about even where Docker access does work:

- This host's own Docker Desktop VM is **arm64** (Apple Silicon), so a `--platform linux/arm64`
  build here would be **native**, not QEMU-emulated — the reverse of what a GitHub Actions
  (`ubuntu-latest`, amd64) runner experiences building the same target. True
  amd64-host-emulating-arm64 verification isn't reproducible on this machine at all.
- Given that, the real, decisive test of "does CI's QEMU-emulated arm64 leg succeed" is still
  #2486/#2487 landing and actually running in CI — this audit reduces the risk going into that, it
  doesn't replace it.

Given the blocked container build, this audit instead verified the same question — will
`npm ci --omit=dev` inside the arm64 image need to compile anything native, or can it resolve
prebuilt binaries — directly against the dependency tree and the npm registry:

1. Enumerated every package in `backend/package-lock.json` with an npm `install` lifecycle script
   (`hasInstallScript`) — the only packages capable of running node-gyp/native compilation at
   install time.
2. For the one genuinely native package (`sharp`), fetched and inspected the actual npm tarballs
   for its `linux-arm64` platform packages to confirm they're prebuilt binaries, not source.
3. Cross-checked the apt-installed Chromium dependency against Debian's package archive for
   `bookworm`/`arm64`.
4. Ran a real `npm ci` for `backend/` on this host (arm64 macOS — not Linux, see caveat below) as a
   supplementary, lower-fidelity check of npm's optional-platform-dependency resolution mechanism.

## Findings

### Only five packages have any install-time script at all

```
cpu-features   0.0.10   optional (via ssh2)
esbuild        0.25.12  dev-only
fsevents       2.3.3    optional, os:[darwin] — never attempted on Linux
puppeteer      25.4.0   optional
ssh2           1.17.0   required (transitive prod dep, via ssh2-sftp-client)
```

Everything else in the tree — `pg`, `bcryptjs` (deliberately chosen over `bcrypt`), `ldapts`,
`yjs`/`lib0`, etc. — is pure JS with no install script at all.

- **`esbuild`** is `dev`-only, excluded entirely by `dev/build/Dockerfile`'s `npm ci --omit=dev`.
  Not a production-image concern. (It does ship real `linux-arm64` prebuilt binaries too, for
  whichever local/CI tooling installs full `devDependencies` on arm64.)
- **`fsevents`** is macOS-only (`os: ["darwin"]`) — npm's own os-gating means it is never even
  attempted on Linux, arm64 or amd64. Not a concern.
- **`puppeteer`**'s install script normally downloads a Chromium build, but
  `dev/build/Dockerfile` sets `PUPPETEER_SKIP_DOWNLOAD=true` before `npm ci` and resolves the
  distro-packaged Chromium instead (`ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`). No
  compilation of any kind is involved. Debian's `chromium` package is built for `arm64` on
  `bookworm` (confirmed directly against `packages.debian.org` / the Debian archive madison API —
  alongside `amd64`, `armhf`, `i386`, `ppc64el`), matching the Dockerfile's own comment claiming
  this.
- **`ssh2`** (required, via `ssh2-sftp-client`) has **no `gypfile` of its own** (confirmed against
  its published `package.json`) — its `install.js` exists solely to opportunistically build the one
  genuinely native piece, `cpu-features`, and is designed to degrade gracefully if that fails.
- **`cpu-features`** is the one package here that actually ships C++ source with a real
  `binding.gyp` (confirmed by downloading and inspecting its tarball — full `deps/cpu_features/`
  source tree, `src/binding.cc`, `nan` as a build-time dependency) and genuinely needs node-gyp
  (a C/C++ toolchain + Python) to compile. It is declared as `ssh2`'s own `optionalDependency`
  (`~0.0.10`), and marked `optional: true` in the lockfile — so if its compile fails, npm treats it
  as a non-fatal, skippable optional dependency (does not fail `npm ci`), and `ssh2` runs with its
  pure-JS fallback (used for TLS/SSH kex CPU-feature detection performance only, not correctness).

**Adjacent, non-blocking observation, not specific to arm64:** neither the `node:26.7.0-bookworm`
base image nor `dev/build/Dockerfile`'s own `apt-get install` list includes `python3`, which
node-gyp needs to build `cpu-features` at all. If that holds, `cpu-features` most likely already
fails to compile (silently, non-fatally, same as above) in the **current, amd64-only** production
image today — this is not something adding `linux/arm64` introduces or changes. It wasn't chased
further here since it's out of this WP's scope (arm64 verification) and has a working, intentional
fallback either way; worth a one-line confirmation the first time a real containerized build runs
(#2486), but not a blocker for adding arm64.

### `sharp` — the one dependency actually worth worrying about — is fine

`sharp` (`optionalDependency`, used by `backend/helpers/images.ts` for thumbnails/resizing, already
behind a graceful "sharp not installed" fallback path even when entirely absent) has **no
install script of its own** — it dispatches at runtime to whichever per-platform optional package
npm resolved for the install platform. `backend/package-lock.json` already declares
`@img/sharp-linux-arm64@0.35.3` and `@img/sharp-libvips-linux-arm64@1.3.2` as optional platform
packages (alongside the `linuxmusl` variant for Alpine-based images, and every other platform sharp
supports).

Downloaded and inspected both tarballs directly from the npm registry:

- `@img/sharp-linux-arm64-0.35.3.tgz` — 5 files, ~542 KB unpacked: `LICENSE`, `index.cjs`,
  `package.json`, `README.md`, and **`lib/sharp-linux-arm64-0.35.3.node`** — a genuine prebuilt
  native binary, no source, nothing to compile.
- `@img/sharp-libvips-linux-arm64-1.3.2.tgz` — ~17.8 MB unpacked, the prebuilt libvips shared
  library sharp links against.

So on a real `linux/arm64` container, `npm ci --omit=dev` resolves and installs these two prebuilt
packages exactly as it does the `linux-x64` pair on `amd64` today — no compilation, no toolchain
dependency, nothing arm64-specific to worry about.

### Supplementary check: a real local `npm ci` on this (arm64) host

Ran `npm ci` for `backend/` directly on this machine (arm64 macOS — **not** Linux, so this proves
npm's optional-dependency-resolution mechanism works correctly for the `arm64` CPU architecture, not
that the Linux container specifically builds clean):

```
added 704 packages in 8s
```

No errors. `node_modules/@img/sharp-darwin-arm64` (the macOS-arm64 counterpart to the Linux one
above) was correctly resolved and installed with a real prebuilt `.node` binary, and
`require('sharp')` loaded and reported a full `sharp.versions` object. `cpu-features` also compiled
successfully here (macOS has Python + Xcode Command Line Tools available), producing a real
`build/Release/cpufeatures.node`, and `require('ssh2')` loaded fine. This corroborates the registry
findings above but does not, on its own, prove the Linux/arm64 container path — that's still
#2486's job to confirm empirically in CI.

## Conclusion

No arm64-specific blocker was found in `backend/`'s native dependency footprint. The one
consequential native dependency (`sharp`) ships genuine prebuilt `linux-arm64` binaries for the
exact pinned versions in `package-lock.json`, and the one genuinely-compiled dependency
(`cpu-features`, via `ssh2`) is optional with an intentional, working fallback, on every
architecture, not just arm64. `puppeteer` and the apt-installed Chromium it's pointed at are both
confirmed available on `arm64`. **Recommendation: proceed with #2486/#2487** (adding `linux/arm64`
to the buildx builds); a real containerized build under CI's actual QEMU emulation — which this
environment could not produce — remains the acceptance bar #2488 already covers ("Verify published
multi-arch manifest on a real ARM host"), and is the first point this audit's predictions get
empirically confirmed end-to-end.

`backend/test/arm64NativeDeps.test.ts` codifies the structural facts above (the exact
`hasInstallScript` set, `sharp`'s `linux-arm64` optional packages, `cpu-features` staying optional)
as an ongoing regression guard, so a future dependency bump that changes any of them is caught at
test time rather than discovered as a broken arm64 image build.
