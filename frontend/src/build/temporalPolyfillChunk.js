// -> The module id behind `temporal-polyfill`'s `./global` export: `global.esm.js` at the package
//    root, or `full/global.esm.js` for the `full` variant. Matched on the id's tail so it does not
//    matter whether the path arrives absolute, npm-flat, or through a pnpm-style symlink hop.
const TEMPORAL_POLYFILL_MODULE_RE = /[\\/]temporal-polyfill[\\/](full[\\/])?global\.esm\.js$/

export const TEMPORAL_POLYFILL_PLACEHOLDER = '<!--temporal-polyfill-chunk-url-->'

/**
 * Takes the plain `OutputBundle` rather than reading the plugin's captured state, so a unit test can
 * exercise it against a synthetic bundle with no real build. Throws rather than returning an empty
 * name when no chunk matches: a silently empty URL would ship an inline script assigning
 * `window.__wikiTemporalPolyfillUrl` to garbage, a far harder failure to notice than a build that
 * refuses to finish.
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
 * Deliberately emits no `<link rel="modulepreload">`: the chunk is kept out of Vite's own preload
 * links because an unconditional preload would cost every browser with native `Temporal` a download
 * it never uses. Supplying the URL alone lets a feature-detect script preload it conditionally.
 */
export function temporalPolyfillChunkPlugin() {
  let base = '/'
  let bundle = null

  return {
    name: 'wiki-temporal-polyfill-chunk',
    configResolved(config) {
      base = config.base
    },
    // -> Never runs for the dev server, so `bundle` stays null there and the placeholder is left
    //    alone. Captures the bundle rather than resolving the chunk eagerly: this plugin also comes
    //    along with builds that emit no `index.html` at all and legitimately carry no
    //    `boot/temporal.js` chunk, so the search -- and its throw -- belongs in `transformIndexHtml`.
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
