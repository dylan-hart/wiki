import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
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

  test('links the web app manifest through the current-site alias, like the favicon', () => {
    const markup = fs.readFileSync(indexHtmlPath, 'utf8').replace(/<!--[\s\S]*?-->/g, '')
    expect(markup).toMatch(/<link\s+rel="manifest"\s+href="\/_site\/current\/manifest"\s*\/?>/)
  })

  test('injects no link when Temporal is already present natively', () => {
    globalThis.Temporal = {}
    window.__wikiTemporalPolyfillUrl = '/_assets/global.esm-abc123.js'

    new Function(script)()

    expect(document.head.querySelector('link[rel="modulepreload"]')).toBeNull()
  })
})

describe('view transition rejection guard (index.html)', () => {
  const guardScriptRe = /<script>([^<]*?pagereveal[^<]*?)<\/script>/

  function extractGuardScript() {
    const match = fs.readFileSync(indexHtmlPath, 'utf8').match(guardScriptRe)
    if (!match) {
      throw new Error('Could not find the inline pagereveal guard script in index.html.')
    }
    return match[1]
  }

  function transitionEvent(type, viewTransition) {
    const event = new Event(type)
    event.viewTransition = viewTransition
    return event
  }

  function skippedTransition() {
    const skipped = () => Promise.reject(new DOMException('Transition was skipped', 'AbortError'))
    const ready = skipped()
    const finished = skipped()
    return {
      ready,
      finished,
      readyCatch: vi.spyOn(ready, 'catch'),
      finishedCatch: vi.spyOn(finished, 'catch')
    }
  }

  test('is a classic inline script in <head>, ahead of the deferred main.js module', () => {
    const html = fs.readFileSync(indexHtmlPath, 'utf8')
    const scriptTag = html.match(guardScriptRe)[0]
    const scriptAt = html.indexOf(scriptTag)
    expect(scriptTag).not.toMatch(/type=["']module["']/)
    expect(scriptTag).not.toMatch(/\b(defer|async)\b/)
    expect(scriptAt).toBeLessThan(html.indexOf('</head>'))
    expect(scriptAt).toBeLessThan(html.indexOf('src="/src/main.js"'))
  })

  test.each(['pagereveal', 'pageswap'])(
    'handles a skipped transition on %s so it never surfaces as an unhandled rejection',
    async (type) => {
      new Function(extractGuardScript())()
      const transition = skippedTransition()

      window.dispatchEvent(transitionEvent(type, transition))

      expect(transition.readyCatch).toHaveBeenCalledWith(expect.any(Function))
      expect(transition.finishedCatch).toHaveBeenCalledWith(expect.any(Function))
      await expect(transition.readyCatch.mock.results[0].value).resolves.toBeUndefined()
      await expect(transition.finishedCatch.mock.results[0].value).resolves.toBeUndefined()
    }
  )

  test('ignores a navigation that carries no view transition', () => {
    new Function(extractGuardScript())()

    expect(() => window.dispatchEvent(transitionEvent('pagereveal', null))).not.toThrow()
    expect(() => window.dispatchEvent(new Event('pagereveal'))).not.toThrow()
  })

  describe('an inbound transition skipped before pagereveal', () => {
    afterEach(() => {
      delete document.activeViewTransition
    })

    test('handles the transition already active while <head> parses, which pagereveal reports as null', async () => {
      const transition = skippedTransition()
      Object.defineProperty(document, 'activeViewTransition', {
        configurable: true,
        value: transition
      })

      new Function(extractGuardScript())()
      window.dispatchEvent(transitionEvent('pagereveal', null))

      expect(transition.readyCatch).toHaveBeenCalledWith(expect.any(Function))
      expect(transition.finishedCatch).toHaveBeenCalledWith(expect.any(Function))
      await expect(transition.readyCatch.mock.results[0].value).resolves.toBeUndefined()
      await expect(transition.finishedCatch.mock.results[0].value).resolves.toBeUndefined()
    })

    test('runs without throwing when the browser has no document.activeViewTransition', () => {
      expect('activeViewTransition' in document).toBe(false)

      expect(() => new Function(extractGuardScript())()).not.toThrow()
    })
  })
})
