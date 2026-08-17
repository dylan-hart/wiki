/**
 * Global test setup: `Temporal` is native from Node 26 (this repo's engine requirement) but this
 * sandbox runs Node 25.9, so tests need the same polyfill the app itself lazily loads in the browser
 * for pre-Temporal Safari (`src/boot/temporal.js`) -- loaded eagerly here instead, and only when the
 * global is actually missing, so this is a no-op on a real Node 26 runtime.
 */
if (typeof Temporal === 'undefined') {
  const { Temporal } = await import('temporal-polyfill')
  globalThis.Temporal = Temporal
}
