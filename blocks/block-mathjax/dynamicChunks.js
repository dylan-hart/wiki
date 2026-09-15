/**
 * `@mathjax/mathjax-newcm-font`'s dynamically-loaded SVG glyph chunks — extpfeil's extensible
 * arrows, `\verb`'s monospace glyphs, and every non-Latin or accented Unicode range the font ships
 * separately from its base bundle rather than inside it.
 *
 * MathJax's own `FontData.dynamicFileName()` (`@mathjax/src`) decides which one it needs at
 * *typesetting* time, as a string assembled at runtime — `dynamicPrefix + '/' + file + '.js'`, with
 * `dynamicPrefix` defaulting to the bare package specifier `@mathjax/mathjax-newcm-font/js/svg/
 * dynamic` — and hands it to `mathjax.asyncLoad`. The bundler can only fold an `import()` into its
 * own chunk graph when the call's specifier is a literal it can see in the source; a string built at
 * runtime is opaque to it, and handing that runtime string straight to a browser's native `import()`
 * is exactly the previously-broken behavior this block shipped (a bare specifier with nothing to
 * resolve it — no import map, no bundler watching at request time). So every file the installed
 * package ships gets its own literal `import()` here, which Rolldown's default multi-entry code
 * splitting turns into its own chunk under `compiled/` with no config change needed — and
 * `component.js`'s `mathjax.asyncLoad` hook picks the matching entry out of this map instead of
 * passing MathJax's computed name to `import()` unchanged.
 *
 * `dynamicChunks.test.js` is the guard against this list drifting from the package's actual
 * `svg/dynamic/` contents on a version bump — the same shape of check `rolldown.config.mjs`'s
 * `blocksManifest()` runs against block directories, applied here to a third-party font package.
 */
export const DYNAMIC_CHUNKS = {
  PUA: () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/PUA.js'),
  'accents-b-i': () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/accents-b-i.js'),
  accents: () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/accents.js'),
  arabic: () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/arabic.js'),
  arrows: () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/arrows.js'),
  'braille-d': () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/braille-d.js'),
  braille: () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/braille.js'),
  calligraphic: () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/calligraphic.js'),
  cherokee: () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/cherokee.js'),
  'cyrillic-ss': () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/cyrillic-ss.js'),
  cyrillic: () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/cyrillic.js'),
  devanagari: () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/devanagari.js'),
  'double-struck': () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/double-struck.js'),
  fraktur: () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/fraktur.js'),
  'greek-ss': () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/greek-ss.js'),
  greek: () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/greek.js'),
  hebrew: () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/hebrew.js'),
  'latin-b': () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/latin-b.js'),
  'latin-bi': () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/latin-bi.js'),
  'latin-i': () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/latin-i.js'),
  latin: () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/latin.js'),
  marrows: () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/marrows.js'),
  math: () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/math.js'),
  'monospace-ex': () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace-ex.js'),
  'monospace-l': () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace-l.js'),
  monospace: () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace.js'),
  mshapes: () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/mshapes.js'),
  'phonetics-ss': () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/phonetics-ss.js'),
  phonetics: () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/phonetics.js'),
  'sans-serif-b': () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-b.js'),
  'sans-serif-bi': () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-bi.js'),
  'sans-serif-ex': () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-ex.js'),
  'sans-serif-i': () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-i.js'),
  'sans-serif-r': () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-r.js'),
  'sans-serif': () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif.js'),
  script: () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/script.js'),
  shapes: () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/shapes.js'),
  'symbols-b-i': () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/symbols-b-i.js'),
  symbols: () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/symbols.js'),
  variants: () => import('@mathjax/mathjax-newcm-font/js/svg/dynamic/variants.js')
}
