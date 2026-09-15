# Pin `puppeteer` to the Chrome-for-Testing build closest to the apt-installed `chromium`

**Status:** Decided. **Date:** 2026-09-14. **Related:** OpenProject #3256 (this bug), #2244 (the
epic that made `--no-sandbox` an opt-in fallback), #3214 (verified the sandbox fallback itself
works).

## The problem

`dev/build/Dockerfile` installs Debian bookworm's `chromium` apt package and points Puppeteer at it
via `PUPPETEER_EXECUTABLE_PATH`/`PUPPETEER_SKIP_DOWNLOAD`, rather than letting Puppeteer download its
own Chrome-for-Testing build. That apt package's version floats with whatever bookworm currently
serves; `backend/package.json`'s `puppeteer` version does not move on its own. #3256 found that once
those two drift far enough apart, `page.goto()` fails outright with `net::ERR_INVALID_ARGUMENT` even
though the browser itself launches cleanly (confirmed separately from, and downstream of, the
sandbox-startup problem #3214 tracked): `puppeteer@25.4.0` was built against Chrome
`151.0.7922.47`, while the apt `chromium` package in the affected build had already reached
`152.0.7977.75` — a newer build validating a CDP parameter more strictly than the older client
library expected to need.

## What was checked

Every `puppeteer-core` release bundles the exact Chrome-for-Testing build it was developed and
protocol-tested against, at `lib/puppeteer/revisions.js`. Pulled from the npm registry directly
(`npm view puppeteer-core@<version> dependencies`, then `npm pack`/`tar xzf` to read the bundled
file) for the versions available at the time of this fix:

| `puppeteer` version | pinned Chrome build  |
| -------------------- | --------------------- |
| 25.4.0 (previous pin) | 151.0.7922.47          |
| 25.5.0                | 151.0.7922.71          |
| 25.7.0                | 152.0.7977.42          |
| **25.9.0 (new pin)**  | **152.0.7977.54**      |
| 25.11.0 (latest)      | 153.0.8010.36          |

The apt `chromium` build reported in #3256's repro was `152.0.7977.75` — in the same
`152.0.7977.x` build train as `25.9.0`'s pinned `152.0.7977.54`, and the closest match on the
registry at the time. `25.11.0` (the newest release, and what a routine `npx ncu -i` would otherwise
pick) pins Chrome `153.x` instead, which would just reintroduce the same class of skew the other
direction against today's `152.x` apt package.

## Decision

1. **Pin `puppeteer` to `25.9.0`, not the newest available release**, specifically because its
   bundled Chrome-for-Testing build is the closest available match to the `chromium` version
   `dev/build/Dockerfile` currently installs. This is a deliberate divergence from the repo's usual
   "track latest stable" currency default, made for exactly the reason that default carries an
   exception for: doing otherwise reintroduces the bug this ticket exists to fix.
2. **Do not pin the apt `chromium` package to an exact version instead**, at least not in this pass.
   Debian bookworm's repo generally only serves the current version of a package (not the ranges
   `snapshot.debian.org` would be needed for), so a hand-picked exact-version pin risks a `Dockerfile`
   that no longer builds the moment bookworm's own repo moves on — a failure mode with a much higher
   blast radius than the one being fixed, and not something verifiable from a sandbox without a real
   `docker build`. This remains the other half of the tradeoff #3256 itself named, and is left open
   for a follow-up that can actually build and boot the image to confirm a specific apt pin still
   resolves.
3. **`test/puppeteerChromiumVersionPin.test.ts` guards the pairing going forward**: it fails a
   `puppeteer` bump that doesn't also update the test's own expected-version constant, and — where
   `puppeteer-core` is actually installed (i.e. in CI, which runs `npm ci`) — separately checks the
   installed package's bundled Chrome major version against the one this decision verified. Bumping
   `puppeteer` in a future currency pass means deliberately re-running the check in the table above
   against whatever `chromium` version is current at that time, not just editing the version string.

## What this decision does NOT cover

This has not been verified end-to-end against a real built `dev/build/Dockerfile` image — that would
require a `docker build` plus a real PDF export request, neither of which this sandbox can do. Real
confirmation that `net::ERR_INVALID_ARGUMENT` is actually gone is a manual repeat of #3256's own repro
steps (build the image, boot with `security.allowPuppeteerNoSandbox: true` on a fresh database,
request a page's PDF export) — worth folding into a repeatable script alongside this project's other
Puppeteer/Docker verification tooling once one exists on this branch — and should happen before this
is treated as fully closed rather than "the documented hypothesis acted on."
