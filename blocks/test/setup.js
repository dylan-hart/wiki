/*
  jsdom 30 (this workspace's pinned version) implements the `CSSStyleSheet` constructor but not
  `Document.prototype.adoptedStyleSheets` -- `'adoptedStyleSheets' in document` is `false`, so any
  module that reads or assigns it throws `TypeError` at import time, before a single test runs.
  `block-katex/component.js` does exactly that at module scope (it hoists KaTeX's `@font-face` rules
  onto the document once, for every formula on the page to share -- see the comment above
  `fontSheet` there), so without this shim no test can even import that block.

  A plain mutable data property is enough for how the real code uses it -- read the current array,
  spread it into a new one, reassign -- nothing here needs the live/observable semantics of the real
  spec type.
*/
if (!('adoptedStyleSheets' in document)) {
  Object.defineProperty(document, 'adoptedStyleSheets', {
    value: [],
    writable: true,
    configurable: true
  })
}

/**
 * `Temporal` is native from Node 26 (this repo's engine requirement) but this sandbox runs Node
 * 25.9, which lacks it -- block-countdown reads it as a bare global (the same way backend/frontend
 * code does), so a test exercising it needs the same polyfill frontend/test/setup.js loads for its
 * own Node 25.9 sandbox. A no-op on a real Node 26 runtime.
 */
if (typeof Temporal === 'undefined') {
  const { Temporal } = await import('temporal-polyfill')
  globalThis.Temporal = Temporal
}
