import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { pageShellFragments, withShellTitle } from './shellHead.ts'
import type { ShellPage } from './shellPage.ts'

const page = (overrides: Partial<ShellPage> = {}): ShellPage => ({
  title: 'Guide',
  description: 'How to',
  path: 'docs/guide',
  locale: 'en',
  translations: [{ locale: 'en', path: 'docs/guide' }],
  ...overrides
})

const ORIGIN = 'https://wiki.test'
const LOCALES = { primary: 'en', active: ['en', 'fr'] }

describe('withShellTitle', () => {
  const shell = '<head><title>Cardinal.js</title></head>'

  test('replaces the static title rather than adding a second one', () => {
    const out = withShellTitle(shell, 'Guide')
    assert.equal(out, '<head><title>Guide</title></head>')
    assert.equal(out.split('<title').length - 1, 1)
  })

  test('escapes the title and keeps $ patterns literal', () => {
    const out = withShellTitle(shell, `$& $1 </title><script>x</script> "q" 'a'`)
    assert.equal(
      out,
      '<head><title>$&amp; $1 &lt;/title&gt;&lt;script&gt;x&lt;/script&gt; &quot;q&quot; &#39;a&#39;</title></head>'
    )
  })

  test('a template with no title comes back unchanged', () => {
    assert.equal(withShellTitle('<head></head>', 'Guide'), '<head></head>')
  })
})

describe('pageShellFragments', () => {
  test('carries description, canonical, og and twitter tags, in the head only', () => {
    const fragments = pageShellFragments(page(), { origin: ORIGIN, locales: LOCALES })
    assert.equal(fragments.bodyEnd, undefined)
    const head = fragments.head!
    assert.ok(head.includes('<meta name="description" content="How to">'))
    assert.ok(head.includes('<link rel="canonical" href="https://wiki.test/docs/guide">'))
    assert.ok(head.includes('<meta property="og:title" content="Guide">'))
    assert.ok(head.includes('<meta property="og:url" content="https://wiki.test/docs/guide">'))
    assert.ok(head.includes('<meta property="og:description" content="How to">'))
    assert.ok(head.includes('<meta name="twitter:card" content="summary">'))
    assert.ok(head.includes('<meta name="twitter:title" content="Guide">'))
    assert.ok(head.includes('<meta name="twitter:description" content="How to">'))
    assert.ok(!head.includes('<title'))
  })

  test('a lone translation emits no hreflang alternates', () => {
    const head = pageShellFragments(page(), { origin: ORIGIN, locales: LOCALES }).head!
    assert.ok(!head.includes('hreflang'))
  })

  test('translations list every locale, self included, with localized URLs', () => {
    const head = pageShellFragments(
      page({
        translations: [
          { locale: 'en', path: 'docs/guide' },
          { locale: 'fr', path: 'docs/guide' }
        ]
      }),
      { origin: ORIGIN, locales: LOCALES }
    ).head!
    assert.ok(
      head.includes('<link rel="alternate" hreflang="en" href="https://wiki.test/docs/guide">')
    )
    assert.ok(
      head.includes('<link rel="alternate" hreflang="fr" href="https://wiki.test/fr/docs/guide">')
    )
  })

  test('a non-primary page canonical carries its locale prefix', () => {
    const head = pageShellFragments(page({ locale: 'fr' }), {
      origin: ORIGIN,
      locales: LOCALES
    }).head!
    assert.ok(head.includes('<link rel="canonical" href="https://wiki.test/fr/docs/guide">'))
    assert.ok(head.includes('<meta property="og:locale" content="fr">'))
  })

  test('a missing or blank description drops every description tag', () => {
    for (const description of [null, '  ']) {
      const head = pageShellFragments(page({ description }), {
        origin: ORIGIN,
        locales: LOCALES
      }).head!
      assert.ok(!head.includes('description'))
    }
  })

  test('every value is escaped and never parsed as markup', () => {
    const evil = `"><script>alert(1)</script> & 'x'`
    const head = pageShellFragments(
      page({
        title: evil,
        description: evil,
        path: `a"b`,
        locale: `x"y`,
        translations: [
          { locale: `x"y`, path: `a"b` },
          { locale: 'en', path: `<c>` }
        ]
      }),
      { origin: ORIGIN, locales: LOCALES }
    ).head!
    assert.ok(!head.includes('<script'))
    assert.ok(!head.includes('"><script'))
    assert.ok(head.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; &#39;x&#39;'))
    assert.ok(head.includes('hreflang="x&quot;y"'))
    assert.ok(head.includes('/a&quot;b'))
    assert.ok(head.includes('/&lt;c&gt;'))
  })
})
