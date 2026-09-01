/**
 * Installs the real `Temporal` global at boot, for every backend entry point (`index.ts`, `worker.ts`).
 *
 * Contrary to this repo's prior assumption, Node does not ship `Temporal` as an unflagged native
 * global on Node 26 -- verified directly against a real `node` 26.7.0 binary: `typeof Temporal` is
 * `undefined`, `Date.prototype.toTemporalInstant` does not exist, and neither `--harmony-temporal`
 * nor `--experimental-temporal` change that (the former isn't even a recognized flag on that build).
 * `@js-temporal/polyfill` was a devDependency only, reachable from `test/temporal.ts`'s test-only
 * `ensureTemporal()` -- so every real boot of the app had no `Temporal` at all, and any code path
 * that reached `Temporal.*` or `date.toTemporalInstant()` (locales refresh, SEO sitemap, page
 * serialization/export, search indexing, storage sync tick checks, API key expiration, pageviews
 * summary, ...) crashed. See `docs/decisions/` for more if this gets written up further.
 *
 * Feature-detected so this becomes a no-op the moment a future Node release ships it natively.
 */
export async function ensureTemporal(): Promise<void> {
  if (typeof Temporal === 'undefined') {
    const polyfill = await import('@js-temporal/polyfill')
    ;(globalThis as any).Temporal = polyfill.Temporal
    ;(Date.prototype as any).toTemporalInstant = function (this: Date) {
      return polyfill.toTemporalInstant.call(this)
    }
  }
}
