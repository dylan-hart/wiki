// -> A path (module id) belonging to `temporal-polyfill`'s `./global` export, which
//    `boot/temporal.js` dynamically imports (`import('temporal-polyfill/global')`). That export maps
//    to `global.esm.js` at the package root, or `full/global.esm.js` for the `temporal-polyfill/full`
//    variant -- see `temporal-polyfill`'s own `package.json#exports`. Matched on the module id's tail
//    so it doesn't matter whether the path arrives absolute, npm-flat, or through a pnpm-style
//    `node_modules/.pnpm/...` symlink hop.
const TEMPORAL_POLYFILL_MODULE_RE = /[\\/]temporal-polyfill[\\/](full[\\/])?global\.esm\.js$/

export const TEMPORAL_POLYFILL_PLACEHOLDER = '<!--temporal-polyfill-chunk-url-->'

/**
 * Finds the built chunk carrying temporal-polyfill's `global.esm` module in a Rollup/Rolldown
 * `OutputBundle` (the object `generateBundle`/`writeBundle` receive, keyed by output file name) and
 * returns that chunk's `fileName` -- e.g. `_assets/global.esm-XXXXXXXX.js`.
 *
 * A pure function, deliberately: it takes the plain bundle object rather than reading the plugin's
 * own captured state, so it can be exercised in a unit test against a synthetic sample bundle with no
 * real build involved. Throws rather than returning `null`/`''` when no matching chunk is present --
 * a silently empty URL would ship an inline script assigning `window.__wikiTemporalPolyfillUrl` to
 * garbage, which is a much harder failure to notice than a build that refuses to finish.
 */
export function findTemporalPolyfillChunkFileName(bundle) {
  const chunk = Object.values(bundle).find(
    (output) =>
      output.type === 'chunk' &&
      Array.isArray(output.moduleIds) &&
      output.moduleIds.some((id) => TEMPORAL_POLYFILL_MODULE_RE.test(id))
  )
  if (!chunk) {
    throw new Error(
      "temporalPolyfillChunk: no output chunk carries temporal-polyfill's global.esm module. Either " +
        "`boot/temporal.js` no longer imports 'temporal-polyfill/global', or the dependency changed " +
        'its export layout -- check `temporal-polyfill`\'s `package.json#exports["./global"]` against ' +
        'the TEMPORAL_POLYFILL_MODULE_RE pattern in this file.'
    )
  }
  return chunk.fileName
}

/**
 * Substitutes the real, hashed build URL of the temporal-polyfill chunk into the
 * `<!--temporal-polyfill-chunk-url-->` placeholder in `index.html`, as an inline script that sets
 * `window.__wikiTemporalPolyfillUrl`.
 *
 * This deliberately does NOT emit a `<link rel="modulepreload">` itself: the chunk is intentionally
 * absent from Vite's own modulepreload links (an unconditional preload would waste ~20 KB gzipped on
 * every browser with native `Temporal`). It only supplies the URL a feature-detect script -- added
 * separately -- can use to preload the chunk conditionally, for browsers that still need it.
 */
export function temporalPolyfillChunkPlugin() {
  let base = '/'
  let bundle = null

  return {
    name: 'wiki-temporal-polyfill-chunk',
    configResolved(config) {
      base = config.base
    },
    // -> Never runs for the dev server (only a real build produces an output bundle), so `bundle`
    //    stays null there and the placeholder is left untouched -- `boot/temporal.js` already
    //    dynamically imports the polyfill directly in dev, with no chunk URL to preload. Only
    //    captures the bundle here rather than resolving the chunk eagerly -- this plugin comes along
    //    with every build that shares this file's `vite.config.js`, including ones with no
    //    `index.html` in their output at all (e.g. `test/realGridLayout.js`'s CSS-only build), which
    //    legitimately carry no `boot/temporal.js` chunk to find. Resolving lazily in
    //    `transformIndexHtml` means the search -- and its throw on a genuine mismatch -- only runs
    //    for a build that actually has an `index.html` to substitute the placeholder into.
    generateBundle(_options, outputBundle) {
      bundle = outputBundle
    },
    transformIndexHtml(html) {
      if (bundle === null || !html.includes(TEMPORAL_POLYFILL_PLACEHOLDER)) {
        return html
      }
      const chunkUrl = base + findTemporalPolyfillChunkFileName(bundle)
      return html.replace(
        TEMPORAL_POLYFILL_PLACEHOLDER,
        `<script>window.__wikiTemporalPolyfillUrl = ${JSON.stringify(chunkUrl)}</script>`
      )
    }
  }
}
