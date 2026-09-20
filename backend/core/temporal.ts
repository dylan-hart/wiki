/**
 * Every backend entry point awaits this before anything touches `Temporal`.
 *
 * `Temporal` is native on every official Node 26 build and absent only where V8 was compiled
 * without it (`v8_enable_temporal_support=0`, as Homebrew's Node is), so this is feature-detected
 * and a no-op everywhere else. `temporal-polyfill/global` -- the package `frontend/` and `blocks/`
 * also use -- installs `globalThis.Temporal`, `Date.prototype.toTemporalInstant` and the
 * `Intl.DateTimeFormat` overloads as an import side effect.
 */
export async function ensureTemporal(): Promise<void> {
  if (typeof Temporal === 'undefined') {
    await import('temporal-polyfill/global')
  }
}
