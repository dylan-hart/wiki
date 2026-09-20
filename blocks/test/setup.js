/*
  jsdom implements the `CSSStyleSheet` constructor but not `Document.prototype.adoptedStyleSheets`,
  so any module that reads or assigns it throws `TypeError` at import time, before a single test
  runs. `block-katex/component.js` does exactly that at module scope, so without this shim no test
  can even import that block.

  A plain mutable data property is enough for how the real code uses it -- read the current array,
  spread it into a new one, reassign -- nothing here needs the live semantics of the spec type.
*/
if (!('adoptedStyleSheets' in document)) {
  Object.defineProperty(document, 'adoptedStyleSheets', {
    value: [],
    writable: true,
    configurable: true
  })
}

/*
  `block-countdown` relies in production on `frontend/src/boot/temporal.js` having polyfilled
  `window.Temporal` before any block loads; a block's own test has no such boot sequence to inherit,
  so a runtime without native `Temporal` is polyfilled here the identical way. A no-op on Node 26+.
*/
if (typeof Temporal === 'undefined') {
  const { Temporal } = await import('temporal-polyfill')
  globalThis.Temporal = Temporal
}
