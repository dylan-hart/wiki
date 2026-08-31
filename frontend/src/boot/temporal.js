/**
 * Installs a `Temporal` polyfill on browsers that don't implement it natively yet. As of 2026-08-31,
 * Chrome 144+, Firefox 139+ and Edge 144+ ship native `Temporal` (TC39 Stage 4, part of ECMAScript
 * 2026), but Safari still does not — it remains behind a flag in Safari Technology Preview only, with
 * no stable release support yet. The import is dynamic and guarded, so browsers with native support
 * never download it. Re-check this position (see work package #1828) once Safari ships it stably.
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
