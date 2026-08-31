import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Covers the inline Temporal-polyfill-preload script embedded directly in `index.html` (WP #1838).
 *
 * The script has to live inline and non-module in `index.html` itself to run synchronously during
 * head parsing -- extracting it into an importable module and testing that instead would prove
 * nothing about what actually ships. So this test reads the real file and executes the real script
 * text between its `temporal-polyfill-preload:start`/`:end` markers, in both browser conditions.
 */

// -> Vitest runs this file with `root: frontend/` (this file's own directory), so a cwd-relative
//    path is robust here without needing `import.meta.url`, which this harness does not resolve to
//    a `file:` URL for a workspace-root test file.
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
  })

  afterEach(() => {
    document.head.querySelectorAll('link[rel="modulepreload"]').forEach((el) => el.remove())
    delete globalThis.Temporal
  })

  test('script is present and non-module so it runs synchronously in <head>', () => {
    const html = fs.readFileSync(indexHtmlPath, 'utf8')
    const scriptTag = html.match(/<script>[\s\S]*?__TEMPORAL_POLYFILL_HREF__[\s\S]*?<\/script>/)[0]
    expect(scriptTag).not.toMatch(/type=["']module["']/)
    expect(scriptTag).not.toMatch(/\b(defer|async)\b/)
  })

  test('injects a modulepreload link with the placeholder href when Temporal is missing', () => {
    expect(typeof globalThis.Temporal).toBe('undefined')

    // -> Executes the real shipped inline script text extracted above, not a reimplementation of it
    new Function(script)()

    const link = document.head.querySelector('link[rel="modulepreload"]')
    expect(link).not.toBeNull()
    expect(link.getAttribute('href')).toBe('__TEMPORAL_POLYFILL_HREF__')
  })

  test('injects no link when Temporal is already present natively', () => {
    globalThis.Temporal = {}

    new Function(script)()

    expect(document.head.querySelector('link[rel="modulepreload"]')).toBeNull()
  })
})
