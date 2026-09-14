# Sandboxed Puppeteer (the shipped default) does not work under a plain `docker run`

**Status:** Decided. **Date:** 2026-09-14. **Related:** OpenProject #3214 (verification task), #2247
(the task this corrects), Epic #2244, Issue #3201 (the original "was this ever actually checked?"
question), Bug #3256 (a distinct follow-on finding).

## What was assumed

Task #2247 ("Enable Chromium's sandbox in the production container image") was closed on the
assumption that a container built from `dev/build/Dockerfile`, booted with
`security.allowPuppeteerNoSandbox` left at its default (`false`), would launch headless Chromium with
its own process sandbox enabled and a PDF export would succeed. That specific verification was
explicitly deferred to a later "comprehensive after-merge verification pass" that, per Issue #3201,
was never confirmed to have actually happened.

## What OpenProject #3214 actually found

It didn't happen, and the assumption was wrong. Built exactly from `dev/build/Dockerfile` (unmodified
— see `dev/build/verify-sandboxed-puppeteer.sh`, which reproduces this on demand), booted with a plain
`docker run` (no `--security-opt`, no `--cap-add`, no `--privileged` — i.e. the shape the image's own
`docker run` documentation describes), with `security.allowPuppeteerNoSandbox` at its default `false`:
every headless-browser feature (PDF export exercised directly; page re-render and Mermaid/diagram
render share the same `helpers/puppeteer.ts#launchPuppeteerBrowser`) fails outright. The container log:

```
error http unhandled error, answered 500 ... error="Failed to launch the browser process:  Code: 1

stderr:
[…] ERROR:content/browser/zygote_host/zygote_host_impl_linux.cc:129] No usable sandbox! If this is a
Debian system, please install the chromium-sandbox package to solve this problem. […] If you want to
live dangerously and need an immediate workaround, you can try using --no-sandbox.
```

## Root cause, confirmed directly against the built image

1. **No setuid sandbox helper is available.** Debian bookworm's `chromium` apt package (the one
   `dev/build/Dockerfile` installs) ships no separate `chrome-sandbox`/`chromium-sandbox` setuid-root
   binary at all — confirmed by listing `/usr/lib/chromium/` inside the built image and by
   `apt-cache search chromium` turning up nothing beyond `chromium`/`chromium-common`. Chromium's
   error message above names this as one of the two ways its sandbox can start; it is not available
   here, matching the Dockerfile's own existing comment about why the setuid helper was deliberately
   not installed.
2. **The other way — unprivileged user namespace creation — is blocked by Docker's own default
   seccomp profile**, not by anything this image controls. Confirmed directly: `unshare --user
--map-root-user id`, run as the container's own `node` user inside the built image, fails with
   `unshare: unshare failed: Operation not permitted` on a plain `docker run`, and the identical
   command **succeeds** the moment the same container is started with `--security-opt
seccomp=unconfined`. This isolates the block to the seccomp profile specifically (not capabilities,
   not AppArmor, not a kernel-level `unprivileged_userns_clone` sysctl — that sysctl doesn't even
   exist in this kernel, ruling it out directly). This is also not specific to this one Docker
   Desktop/macOS host: it is the same widely-documented default-seccomp restriction the entire
   Puppeteer/Playwright-in-Docker ecosystem works around (Puppeteer's own troubleshooting guide
   names the identical three remedies below), so a real Linux Docker Engine host with its own default
   seccomp profile hits the same wall.

## Why this is not fixed in `dev/build/Dockerfile`

Both of Chromium's own sandbox mechanisms require something a `Dockerfile` cannot grant to its own
future container: a setuid-root helper binary is a real security tradeoff this project already
decided against once (see the Dockerfile's own comment — it would add a root-owned setuid binary to
every container, precisely what running as `USER node` exists to avoid), and Docker's seccomp
profile / capability set is a property of the **caller's** `docker run` (or Kubernetes pod spec, or
compose file) invocation, not of the image. No `RUN`/`ENV`/`USER` line in a Dockerfile can loosen the
seccomp profile the container it produces will later be started under — that decision is made once,
by whoever runs `docker run`, after the image already exists. A generic public image genuinely cannot
declare "please always run me with `--security-opt seccomp=…`" and have Docker honor it unasked.

## Decision

1. **Keep `allowPuppeteerNoSandbox: false` as the shipped default.** This still matters for any
   operator whose runtime environment DOES grant the container the capability it needs — a Kubernetes
   cluster with a suitable `seccompProfile`, a `docker run` invocation with `--security-opt
seccomp=<profile>` or `--cap-add=SYS_ADMIN`, or a future image revision that finds a safe way to
   ship a real setuid sandbox helper. Flipping the shipped default to `true` would make every such
   operator silently worse off (an always-disabled sandbox they never had a chance to keep), for no
   benefit to an operator who takes no action either way.
2. **Correct the documentation to state this as a CONFIRMED, not hypothetical, fact**, with concrete
   operator remedies instead of a vague "an operator whose deployment environment cannot give Chromium
   its own sandbox" hedge:
   - The simplest remedy, and the one this project already built and documents:
     `security.allowPuppeteerNoSandbox: true`. Loses the sandbox; gains a working instance with zero
     `docker run` changes.
   - The remedy that keeps the sandbox: pass `--security-opt seccomp=<a profile that allows
unprivileged user-namespace creation>` (or, more permissively and only for a fully trusted
     environment, `--cap-add=SYS_ADMIN`) to `docker run`/the container orchestrator. This project does
     not ship such a profile — vendoring and maintaining a modified copy of Docker's own default
     seccomp profile (a large, security-sensitive file that would need to be kept in step with
     Docker's own upstream default) is a real ongoing maintenance cost this decision does not take on
     without a concrete operator need driving it. An operator who wants this route today can start
     from Docker's own default profile and the additions the wider Puppeteer/Chromium-in-Docker
     community already documents for exactly this case.
3. **`dev/build/verify-sandboxed-puppeteer.sh` stays in the repo as a permanent, re-runnable check**,
   referenced from `docs/audits/release-checklist.md`, specifically so this cannot quietly regress
   back into "assumed but unverified" the way #2247 did. It is expected to keep failing on a stock
   `docker run` until one of the two remedies above is actually applied by whoever is running it — a
   FAIL from it is not itself a regression signal unless the message or root cause changes.

## What this decision does NOT cover

A distinct problem surfaced while separately confirming the `allowPuppeteerNoSandbox: true` escape
hatch still works end-to-end on its own terms: it does get Chromium launched (past the sandbox
entirely), but the subsequent page navigation then fails with `net::ERR_INVALID_ARGUMENT`, a
different and still-unconfirmed issue (suspected `puppeteer@25.4.0` vs. the system `chromium` package
version skew) — tracked separately as Bug #3256, not folded into this decision.
