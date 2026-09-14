/**
 * Shared `Temporal` polyfill installer for backend test files.
 *
 * This sandbox's Node (v25.9.0) lacks the native `Temporal` global -- unlike an official Node 26
 * build (this repo's engine floor), which does ship it natively (verified: `typeof Temporal` is
 * `object` on `node:26.8.1-slim` and `node:26.7.0-bookworm`, production's own image). `ensureTemporal()`
 * installs `temporal-polyfill/global`'s real implementation, feature-detected so it is a no-op on a
 * runtime that already has it -- exactly the pattern `models/export.test.ts` used inline before this
 * helper existed. `temporal-polyfill` is the same package `frontend/` and `blocks/` already use, so
 * this is the same polyfill running under test as `core/temporal.ts` installs at boot on a
 * Temporal-less build (Homebrew's, for instance) -- its `/global` entry point installs
 * `globalThis.Temporal` and patches `Date.prototype.toTemporalInstant` as an import side effect, so
 * there is nothing further to wire up here.
 *
 * Use this instead of a hand-rolled fake. A hand-rolled `Temporal.Now.instant()`/`Instant.compare()`
 * stand-in tends to be looser than the real API -- e.g. reducing `{ years: n }` to flat
 * `n * 365 * 86_400_000` milliseconds (wrong across a leap year, and silently accepts `Instant.add()`
 * calendar units that the real `Temporal.Instant` throws on), or implementing `Instant.compare` as a
 * numeric comparison on `epochMilliseconds` (passes a test even where the code under test wrongly wrote
 * `a < b`, which throws against a real `Temporal.Instant`).
 * Installing the real polyfill means both failure modes surface in tests exactly as they would in
 * production under Node 26. See `docs/audit-2026-08-24/testing.md` §7.
 *
 * Call this from a test file's `before()` hook (or at module load, for a file with no `before()` of its
 * own) before importing the module(s) under test. It never uninstalls: the process-wide `Temporal`
 * global is either already the real one (native Node 26) or becomes the real polyfill (Node 25), and
 * either way a second call in the same process is a cheap no-op re-check rather than something that
 * needs restoring in `after()`.
 */
export async function ensureTemporal(): Promise<void> {
  if (typeof Temporal === 'undefined') {
    await import('temporal-polyfill/global')
  }
}
