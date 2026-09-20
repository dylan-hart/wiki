import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

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
