/**
 * Safari has no stable native `Temporal`, so a polyfill is still needed; the import is dynamic and
 * guarded so every other browser never downloads it. Drop the whole thing once Safari ships it.
 *
 * Must run before anything that touches `Temporal` — it is awaited first in `main.js`.
 */
export async function initializeTemporal() {
  if (typeof globalThis.Temporal !== 'undefined') {
    return
  }

  // -> Patches globalThis.Temporal, Intl.DateTimeFormat and Date.prototype.toTemporalInstant
  await import('temporal-polyfill/global')
}
