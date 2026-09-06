import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveAppShellLocale,
  templateAppShell,
  getTemplatedAppShell,
  resetAppShellCache
} from './appShell.ts'

describe('templateAppShell', () => {
  test('sets lang and dir="ltr" for a non-RTL locale', () => {
    const html = '<!DOCTYPE html>\n<html lang="en">\n<head></head>\n<body></body>\n</html>'
    const result = templateAppShell(html, { lang: 'fr', isRTL: false })
    assert.match(result, /<html lang="fr" dir="ltr">/)
  })

  test('sets dir="rtl" for an RTL locale', () => {
    const html = '<html lang="en">\n<head></head>\n</html>'
    const result = templateAppShell(html, { lang: 'ar', isRTL: true })
    assert.match(result, /<html lang="ar" dir="rtl">/)
  })

  test('replaces whatever attributes the existing tag carries, not just lang="en"', () => {
    const html = '<html lang="en" data-theme="light" class="foo">'
    const result = templateAppShell(html, { lang: 'he', isRTL: true })
    assert.equal(result, '<html lang="he" dir="rtl">')
  })

  test('only rewrites the opening <html> tag, leaving the rest of the document untouched', () => {
    const html =
      '<!DOCTYPE html>\n<html lang="en">\n<head><title>Cardinal.js</title></head>\n<body class="wiki-root"><div id="app"></div></body>\n</html>'
    const result = templateAppShell(html, { lang: 'de', isRTL: false })
    assert.match(result, /<title>Cardinal\.js<\/title>/)
    assert.match(result, /<body class="wiki-root"><div id="app"><\/div><\/body>/)
  })

  test('returns the document unchanged if no <html> tag is present', () => {
    const html = '<!DOCTYPE html>\nnot actually html'
    const result = templateAppShell(html, { lang: 'en', isRTL: false })
    assert.equal(result, html)
  })
})

describe('resolveAppShellLocale', () => {
  const cfg = { primary: 'en', active: ['en', 'ar'], forcePrefix: false }

  test('a locale-prefixed page path resolves to its own locale', () => {
    assert.equal(resolveAppShellLocale('/ar/guides/x', undefined, cfg), 'ar')
  })

  test('an app route reads ?locale=', () => {
    assert.equal(resolveAppShellLocale('/_edit/guides/x', 'locale=ar', cfg), 'ar')
  })

  test('an invalid query locale falls back to the primary', () => {
    assert.equal(resolveAppShellLocale('/_edit/guides/x', 'locale=zz', cfg), 'en')
  })

  test('a bare path is the primary', () => {
    assert.equal(resolveAppShellLocale('/guides/x', undefined, cfg), 'en')
  })
})

describe('getTemplatedAppShell', () => {
  beforeEach(() => {
    resetAppShellCache()
  })

  /** Builds injectable fs stand-ins plus call counters, so a test can assert re-read/re-resolve counts. */
  function makeReader(initialHtml: string, initialMtimeMs: number) {
    let html = initialHtml
    let mtimeMs = initialMtimeMs
    const readFile = { calls: 0 }
    const stat = { calls: 0 }
    return {
      set: (nextHtml: string, nextMtimeMs: number) => {
        html = nextHtml
        mtimeMs = nextMtimeMs
      },
      readFile: {
        calls: readFile,
        fn: async (_path: string) => {
          readFile.calls++
          return html
        }
      },
      stat: {
        calls: stat,
        fn: async (_path: string) => {
          stat.calls++
          return { mtimeMs }
        }
      }
    }
  }

  test('a repeated (lang, isRTL) pair returns byte-identical output without re-reading the file', async () => {
    const reader = makeReader('<html lang="en">', 1000)
    let resolveCalls = 0
    const resolveIsRTL = () => {
      resolveCalls++
      return false
    }
    const first = await getTemplatedAppShell('/shell.html', 'fr', resolveIsRTL, {
      readFile: reader.readFile.fn,
      stat: reader.stat.fn
    })
    const second = await getTemplatedAppShell('/shell.html', 'fr', resolveIsRTL, {
      readFile: reader.readFile.fn,
      stat: reader.stat.fn
    })
    assert.equal(first, second)
    assert.equal(first, '<html lang="fr" dir="ltr">')
    assert.equal(reader.readFile.calls.calls, 1)
    assert.equal(resolveCalls, 1)
    // stat is still consulted each call to detect a rebuilt shell, just not the read/template work.
    assert.equal(reader.stat.calls.calls, 2)
  })

  test('a different lang gets its own cache entry', async () => {
    const reader = makeReader('<html lang="en">', 1000)
    const first = await getTemplatedAppShell('/shell.html', 'fr', () => false, {
      readFile: reader.readFile.fn,
      stat: reader.stat.fn
    })
    const second = await getTemplatedAppShell('/shell.html', 'ar', () => true, {
      readFile: reader.readFile.fn,
      stat: reader.stat.fn
    })
    assert.equal(first, '<html lang="fr" dir="ltr">')
    assert.equal(second, '<html lang="ar" dir="rtl">')
    assert.equal(reader.readFile.calls.calls, 2)
  })

  test('touching the shell file mtimeMs forces a re-template', async () => {
    const reader = makeReader('<html lang="en">', 1000)
    let resolveCalls = 0
    const resolveIsRTL = () => {
      resolveCalls++
      return false
    }
    const first = await getTemplatedAppShell('/shell.html', 'fr', resolveIsRTL, {
      readFile: reader.readFile.fn,
      stat: reader.stat.fn
    })
    assert.equal(first, '<html lang="fr" dir="ltr">')

    // Simulate `npm run build` rewriting the shell.
    reader.set('<html lang="en" data-build="2">', 2000)
    const second = await getTemplatedAppShell('/shell.html', 'fr', resolveIsRTL, {
      readFile: reader.readFile.fn,
      stat: reader.stat.fn
    })
    assert.equal(second, '<html lang="fr" dir="ltr">')
    assert.equal(reader.readFile.calls.calls, 2)
    assert.equal(resolveCalls, 2)
  })
})
