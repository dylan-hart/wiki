import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAppShellLocale, templateAppShell } from './appShell.ts'

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
      '<!DOCTYPE html>\n<html lang="en">\n<head><title>Wiki.js</title></head>\n<body class="wiki-root"><div id="app"></div></body>\n</html>'
    const result = templateAppShell(html, { lang: 'de', isRTL: false })
    assert.match(result, /<title>Wiki\.js<\/title>/)
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
