import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { TEMPORAL_POLYFILL_PLACEHOLDER } from './src/build/temporalPolyfillChunk.js'

/**
 * The preload script has to live inline and non-module in `index.html` to run synchronously during
 * head parsing, so extracting it into an importable module and testing that would prove nothing
 * about what ships. This reads the real file and executes the real script text between its
 * `temporal-polyfill-preload:start`/`:end` markers.
 */

// -> Vitest runs this file with `root: frontend/`, so a cwd-relative path resolves; this harness
//    does not give a workspace-root test file a `file:` `import.meta.url` to work from.
const indexHtmlPath = path.resolve(process.cwd(), 'index.html')

function extractPreloadScript() {
  const html = fs.readFileSync(indexHtmlPath, 'utf8')
  const marked = html.match(
    /temporal-polyfill-preload:start[\s\S]*?<script>([\s\S]*?)<\/script>[\s\S]*?temporal-polyfill-preload:end/
  )
  if (!marked) {
    throw new Error(
      'Could not find the temporal-polyfill-preload:start/:end markers in index.html -- the script has moved or been renamed.'
    )
  }
  return marked[1]
}

describe('temporal polyfill preload script (index.html)', () => {
  const script = extractPreloadScript()

  beforeEach(() => {
    document.head.querySelectorAll('link[rel="modulepreload"]').forEach((el) => el.remove())
    delete globalThis.Temporal
    delete window.__wikiTemporalPolyfillUrl
  })

  afterEach(() => {
    document.head.querySelectorAll('link[rel="modulepreload"]').forEach((el) => el.remove())
    delete globalThis.Temporal
    delete window.__wikiTemporalPolyfillUrl
  })

  test('script is present and non-module so it runs synchronously in <head>', () => {
    const html = fs.readFileSync(indexHtmlPath, 'utf8')
    const scriptTag = html.match(/<script>[\s\S]*?__wikiTemporalPolyfillUrl[\s\S]*?<\/script>/)[0]
    expect(scriptTag).not.toMatch(/type=["']module["']/)
    expect(scriptTag).not.toMatch(/\b(defer|async)\b/)
  })

  test('injects a modulepreload link to the injected chunk URL when Temporal is missing', () => {
    expect(typeof globalThis.Temporal).toBe('undefined')
    window.__wikiTemporalPolyfillUrl = '/_assets/global.esm-abc123.js'

    new Function(script)()

    const link = document.head.querySelector('link[rel="modulepreload"]')
    expect(link).not.toBeNull()
    expect(link.getAttribute('href')).toBe('/_assets/global.esm-abc123.js')
  })

  test('injects no link when Temporal is missing but no chunk URL was injected (dev server)', () => {
    expect(typeof globalThis.Temporal).toBe('undefined')

    new Function(script)()

    expect(document.head.querySelector('link[rel="modulepreload"]')).toBeNull()
  })

  test('never references the retired href placeholder', () => {
    const markup = fs.readFileSync(indexHtmlPath, 'utf8').replace(/<!--[\s\S]*?-->/g, '')
    expect(markup).not.toContain('__TEMPORAL_POLYFILL_HREF__')
  })

  test('the chunk-url placeholder precedes the preload script so the URL is defined when it runs', () => {
    const html = fs.readFileSync(indexHtmlPath, 'utf8')
    const placeholderAt = html.indexOf(TEMPORAL_POLYFILL_PLACEHOLDER)
    expect(placeholderAt).toBeGreaterThan(-1)
    expect(html.indexOf(TEMPORAL_POLYFILL_PLACEHOLDER, placeholderAt + 1)).toBe(-1)
    expect(placeholderAt).toBeLessThan(html.indexOf('temporal-polyfill-preload:start'))
  })

  test('injects no link when Temporal is already present natively', () => {
    globalThis.Temporal = {}
    window.__wikiTemporalPolyfillUrl = '/_assets/global.esm-abc123.js'

    new Function(script)()

    expect(document.head.querySelector('link[rel="modulepreload"]')).toBeNull()
  })
})
