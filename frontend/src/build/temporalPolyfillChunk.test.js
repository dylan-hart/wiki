import { describe, expect, test } from 'vitest'
import {
  findTemporalPolyfillChunkFileName,
  TEMPORAL_POLYFILL_PLACEHOLDER,
  temporalPolyfillChunkPlugin
} from './temporalPolyfillChunk.js'

// -> A minimal stand-in for a Rollup/Rolldown OutputChunk -- only the fields the lookup function
//    actually reads.
function chunk(fileName, moduleIds) {
  return { type: 'chunk', fileName, moduleIds }
}

function asset(fileName) {
  return { type: 'asset', fileName }
}

describe('findTemporalPolyfillChunkFileName', () => {
  test('finds the polyfill chunk among several candidate chunks and assets', () => {
    const bundle = {
      'index.html': asset('index.html'),
      '_assets/main-abc123.js': chunk('_assets/main-abc123.js', [
        '/repo/frontend/src/main.js',
        '/repo/frontend/src/boot/temporal.js'
      ]),
      '_assets/vendor-def456.js': chunk('_assets/vendor-def456.js', [
        '/repo/frontend/node_modules/vue/dist/vue.runtime.esm-bundler.js'
      ]),
      '_assets/global.esm-y7gbP13e.js': chunk('_assets/global.esm-y7gbP13e.js', [
        '/repo/frontend/node_modules/temporal-polyfill/global.esm.js'
      ]),
      '_assets/style-ghi789.css': asset('_assets/style-ghi789.css')
    }

    expect(findTemporalPolyfillChunkFileName(bundle)).toBe('_assets/global.esm-y7gbP13e.js')
  })

  test('matches the module id through a pnpm-style nested node_modules path', () => {
    const bundle = {
      '_assets/global.esm-pnpm999.js': chunk('_assets/global.esm-pnpm999.js', [
        '/repo/frontend/node_modules/.pnpm/temporal-polyfill@1.0.4/node_modules/temporal-polyfill/global.esm.js'
      ])
    }

    expect(findTemporalPolyfillChunkFileName(bundle)).toBe('_assets/global.esm-pnpm999.js')
  })

  test('matches the temporal-polyfill/full variant', () => {
    const bundle = {
      '_assets/global.esm-full111.js': chunk('_assets/global.esm-full111.js', [
        '/repo/frontend/node_modules/temporal-polyfill/full/global.esm.js'
      ])
    }

    expect(findTemporalPolyfillChunkFileName(bundle)).toBe('_assets/global.esm-full111.js')
  })

  test('throws rather than returning an empty URL when no polyfill chunk is present', () => {
    const bundle = {
      'index.html': asset('index.html'),
      '_assets/main-abc123.js': chunk('_assets/main-abc123.js', ['/repo/frontend/src/main.js']),
      '_assets/vendor-def456.js': chunk('_assets/vendor-def456.js', [
        '/repo/frontend/node_modules/vue/dist/vue.runtime.esm-bundler.js'
      ])
    }

    expect(() => findTemporalPolyfillChunkFileName(bundle)).toThrow(
      /no output chunk carries temporal-polyfill's global\.esm module/
    )
  })

  test('throws on an empty bundle', () => {
    expect(() => findTemporalPolyfillChunkFileName({})).toThrow()
  })

  test('does not match an unrelated module merely containing "temporal-polyfill" in its path', () => {
    const bundle = {
      '_assets/docs-abc.js': chunk('_assets/docs-abc.js', [
        '/repo/frontend/node_modules/temporal-polyfill-examples/readme.js'
      ])
    }

    expect(() => findTemporalPolyfillChunkFileName(bundle)).toThrow()
  })
})

describe('temporalPolyfillChunkPlugin', () => {
  function buildBundle() {
    return {
      '_assets/global.esm-y7gbP13e.js': chunk('_assets/global.esm-y7gbP13e.js', [
        '/repo/frontend/node_modules/temporal-polyfill/global.esm.js'
      ])
    }
  }

  test('substitutes the placeholder with an inline script assigning the resolved chunk URL', () => {
    const plugin = temporalPolyfillChunkPlugin()
    plugin.configResolved({ base: '/' })
    plugin.generateBundle({}, buildBundle())

    const html = `<head>${TEMPORAL_POLYFILL_PLACEHOLDER}</head>`
    const result = plugin.transformIndexHtml(html)

    expect(result).toBe(
      '<head><script>window.__wikiTemporalPolyfillUrl = "/_assets/global.esm-y7gbP13e.js"</script></head>'
    )
  })

  test('honors a non-root configured base', () => {
    const plugin = temporalPolyfillChunkPlugin()
    plugin.configResolved({ base: '/wiki/' })
    plugin.generateBundle({}, buildBundle())

    const result = plugin.transformIndexHtml(TEMPORAL_POLYFILL_PLACEHOLDER)

    expect(result).toContain('"/wiki/_assets/global.esm-y7gbP13e.js"')
  })

  test('never emits a modulepreload link', () => {
    const plugin = temporalPolyfillChunkPlugin()
    plugin.configResolved({ base: '/' })
    plugin.generateBundle({}, buildBundle())

    const result = plugin.transformIndexHtml(TEMPORAL_POLYFILL_PLACEHOLDER)

    expect(result).not.toContain('modulepreload')
  })

  test('leaves the placeholder untouched when generateBundle never ran (dev server)', () => {
    const plugin = temporalPolyfillChunkPlugin()
    plugin.configResolved({ base: '/' })

    const html = `<head>${TEMPORAL_POLYFILL_PLACEHOLDER}</head>`
    expect(plugin.transformIndexHtml(html)).toBe(html)
  })

  test('propagates the loud failure when the bundle has no polyfill chunk', () => {
    const plugin = temporalPolyfillChunkPlugin()
    plugin.configResolved({ base: '/' })
    // -> Capturing the bundle never throws by itself -- a build with no `index.html` in its output
    //    (and therefore no placeholder to substitute) legitimately has nothing to resolve. The throw
    //    only fires once `transformIndexHtml` actually needs the chunk URL.
    plugin.generateBundle({}, {})

    const html = `<head>${TEMPORAL_POLYFILL_PLACEHOLDER}</head>`
    expect(() => plugin.transformIndexHtml(html)).toThrow(
      /no output chunk carries temporal-polyfill's global\.esm module/
    )
  })

  test('does not resolve the chunk at all when the output has no placeholder to fill in', () => {
    const plugin = temporalPolyfillChunkPlugin()
    plugin.configResolved({ base: '/' })
    // -> An empty bundle would make `findTemporalPolyfillChunkFileName` throw if it ran -- proving
    //    `transformIndexHtml` never calls it for HTML with no placeholder.
    plugin.generateBundle({}, {})

    const html = '<head><title>Some other page</title></head>'
    expect(plugin.transformIndexHtml(html)).toBe(html)
  })
})
