/**
 * Installs `temporal-polyfill/global`'s real implementation on a runtime without a native
 * `Temporal`, feature-detected so it is a no-op where the global already exists. Its `/global` entry
 * point installs `globalThis.Temporal` and patches `Date.prototype.toTemporalInstant` as an import
 * side effect, so there is nothing further to wire up.
 *
 * Call from a test file's `before()` hook (or at module load) before importing the module(s) under
 * test. It never uninstalls -- the process-wide global is the real implementation either way, so
 * there is nothing to restore in `after()`.
 *
 * Use this rather than a hand-rolled fake, which is invariably looser than the real API: a stand-in
 * reducing `{ years: n }` to flat milliseconds silently accepts the calendar units a real
 * `Temporal.Instant.add()` throws on, and one implementing `Instant.compare` numerically passes even
 * where the code under test wrote `a < b`, which throws against a real `Temporal.Instant`.
 */
export async function ensureTemporal(): Promise<void> {
  if (typeof Temporal === 'undefined') {
    await import('temporal-polyfill/global')
  }
}
