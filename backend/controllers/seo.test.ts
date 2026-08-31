import { before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRobotsTxt, buildSitemapXml, buildSitemapIndexXml, paginateSitemap } from './seo.ts'
import type { SitemapPage } from './seo.ts'
import { ensureTemporal } from '../test/temporal.ts'

/**
 * Pure content-generation logic only — no `WIKI` global, no database, no Fastify instance. Everything
 * that decides what a request gets (site resolution, the `sitemap` gate, `listPagesForSitemap`'s
 * guest-rule filtering) is exercised where it actually lives: `models/pages.test.ts` for the query,
 * and there is no server-boot harness in this repo to run the route registration itself against.
 *
 * `buildSitemapXml` reads `Date.prototype.toTemporalInstant().toZonedDateTimeISO('UTC')
 * .toPlainDate().toString()` to produce a UTC `YYYY-MM-DD` — `ensureTemporal()` polyfills that chain
 * for real on this sandbox's Node, which lacks it natively.
 */
before(() => ensureTemporal())

describe('buildRobotsTxt', () => {
  test('allows everything when index and follow are both on', () => {
    const txt = buildRobotsTxt({ robots: { index: true, follow: true }, sitemap: false }, 'ignored')
    assert.equal(txt, 'User-agent: *\nAllow: /\n')
  })

  test('disallows everything when index is off', () => {
    const txt = buildRobotsTxt(
      { robots: { index: false, follow: true }, sitemap: false },
      'ignored'
    )
    assert.equal(txt, 'User-agent: *\nDisallow: /\n')
  })

  test('disallows everything when follow is off, even with index on', () => {
    const txt = buildRobotsTxt(
      { robots: { index: true, follow: false }, sitemap: false },
      'ignored'
    )
    assert.equal(txt, 'User-agent: *\nDisallow: /\n')
  })

  test('treats a missing robots block as fully open', () => {
    const txt = buildRobotsTxt({ sitemap: false }, 'ignored')
    assert.equal(txt, 'User-agent: *\nAllow: /\n')
  })

  test('appends a Sitemap line only when the site has sitemap enabled', () => {
    const txt = buildRobotsTxt(
      { robots: { index: true, follow: true }, sitemap: true },
      'https://wiki.example.com/sitemap.xml'
    )
    assert.equal(txt, 'User-agent: *\nAllow: /\n\nSitemap: https://wiki.example.com/sitemap.xml\n')
  })

  test('omits the Sitemap line when sitemap is disabled, even while indexable', () => {
    const txt = buildRobotsTxt(
      { robots: { index: true, follow: true }, sitemap: false },
      'https://wiki.example.com/sitemap.xml'
    )
    assert.ok(!txt.includes('Sitemap:'))
  })
})

describe('buildSitemapXml', () => {
  test('an empty page list still produces a valid, empty urlset', () => {
    const xml = buildSitemapXml('https://wiki.example.com', [])
    assert.equal(
      xml,
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n</urlset>\n'
    )
  })

  test('one <url> per page, with an absolute <loc> and a date-only <lastmod>', () => {
    const xml = buildSitemapXml('https://wiki.example.com', [
      { path: 'docs/getting-started', locale: 'en', updatedAt: new Date('2026-03-14T10:30:00Z') }
    ])
    assert.ok(xml.includes('<loc>https://wiki.example.com/docs/getting-started</loc>'))
    assert.ok(xml.includes('<lastmod>2026-03-14</lastmod>'))
  })

  test('lists every page, in order', () => {
    const xml = buildSitemapXml('https://wiki.example.com', [
      { path: 'a', locale: 'en', updatedAt: new Date('2026-01-01T00:00:00Z') },
      { path: 'b', locale: 'en', updatedAt: new Date('2026-01-02T00:00:00Z') }
    ])
    const locA = xml.indexOf('<loc>https://wiki.example.com/a</loc>')
    const locB = xml.indexOf('<loc>https://wiki.example.com/b</loc>')
    assert.ok(locA >= 0 && locB >= 0)
    assert.ok(locA < locB)
  })

  test('escapes XML-significant characters in the base URL', () => {
    const xml = buildSitemapXml('https://wiki.example.com/a&b', [
      { path: 'x', updatedAt: new Date('2026-01-01T00:00:00Z'), locale: 'en' }
    ])
    assert.ok(xml.includes('<loc>https://wiki.example.com/a&amp;b/x</loc>'))
    assert.ok(!xml.includes('a&b/x'))
  })

  test('translations emit localized URLs with a full hreflang cluster', () => {
    const xml = buildSitemapXml(
      'https://wiki.example.com',
      [
        { path: 'guides/x', locale: 'en', updatedAt: new Date('2026-08-01T00:00:00Z') },
        { path: 'guides/x', locale: 'fr', updatedAt: new Date('2026-08-02T00:00:00Z') },
        { path: 'solo', locale: 'en', updatedAt: new Date('2026-08-03T00:00:00Z') }
      ],
      { primary: 'en', active: ['en', 'fr'], forcePrefix: false }
    )
    assert.match(xml, /<loc>https:\/\/wiki\.example\.com\/guides\/x<\/loc>/)
    assert.match(xml, /<loc>https:\/\/wiki\.example\.com\/fr\/guides\/x<\/loc>/)
    // both cluster members list BOTH alternates (Google requires self-inclusion)
    assert.equal(
      (xml.match(/hreflang="en" href="https:\/\/wiki\.example\.com\/guides\/x"/g) ?? []).length,
      2
    )
    assert.equal(
      (xml.match(/hreflang="fr" href="https:\/\/wiki\.example\.com\/fr\/guides\/x"/g) ?? []).length,
      2
    )
    // a page with no translations carries no alternate links
    assert.doesNotMatch(xml, /<xhtml:link[^>]*href="[^"]*\/solo"/)
    assert.match(xml, /xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml"/)
  })
})

describe('buildSitemapIndexXml', () => {
  test('an empty child list still produces a valid, empty sitemapindex', () => {
    const xml = buildSitemapIndexXml([])
    assert.equal(
      xml,
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</sitemapindex>\n'
    )
  })

  test('one <sitemap><loc> per child URL, in order', () => {
    const xml = buildSitemapIndexXml([
      'https://wiki.example.com/sitemap.xml?page=1',
      'https://wiki.example.com/sitemap.xml?page=2'
    ])
    const first = xml.indexOf('<loc>https://wiki.example.com/sitemap.xml?page=1</loc>')
    const second = xml.indexOf('<loc>https://wiki.example.com/sitemap.xml?page=2</loc>')
    assert.ok(first >= 0 && second >= 0)
    assert.ok(first < second)
  })

  test('escapes XML-significant characters in a child URL', () => {
    const xml = buildSitemapIndexXml(['https://wiki.example.com/sitemap.xml?page=1&x=y'])
    assert.ok(xml.includes('page=1&amp;x=y'))
    assert.ok(!xml.includes('page=1&x=y'))
  })
})

describe('paginateSitemap', () => {
  const makePages = (count: number): SitemapPage[] =>
    Array.from({ length: count }, (_, i) => ({
      path: `page-${String(i).padStart(6, '0')}`,
      locale: 'en',
      updatedAt: new Date('2026-01-01T00:00:00Z')
    }))

  test('a site under the cap emits the same single flat sitemap it does today, regardless of page', () => {
    const pages = makePages(3)
    const noPage = paginateSitemap('https://wiki.example.com', pages, null, undefined)
    const withPage = paginateSitemap('https://wiki.example.com', pages, null, 1)
    assert.ok('xml' in noPage && 'xml' in withPage)
    assert.match((noPage as { xml: string }).xml, /<urlset/)
    assert.doesNotMatch((noPage as { xml: string }).xml, /<sitemapindex/)
    // -> An out-of-range page for a site that never needed pagination isn't a 404: the query string
    //    just didn't matter
    const outOfRangePage = paginateSitemap('https://wiki.example.com', pages, null, 99)
    assert.ok('xml' in outOfRangePage)
    assert.equal((outOfRangePage as { xml: string }).xml, (noPage as { xml: string }).xml)
  })

  test('a site past the cap emits a sitemap index whose children stay under the cap and resolve to real page URLs', () => {
    const total = 50_000 + 1234
    const pages = makePages(total)
    const index = paginateSitemap('https://wiki.example.com', pages, null, undefined)
    assert.ok('xml' in index)
    const indexXml = (index as { xml: string }).xml
    assert.match(indexXml, /<sitemapindex/)
    const childUrls = [...indexXml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1])
    // -> 51,234 pages split 50,000-at-a-time is two children: one full, one partial
    assert.equal(childUrls.length, 2)
    assert.equal(childUrls[0], 'https://wiki.example.com/sitemap.xml?page=1')
    assert.equal(childUrls[1], 'https://wiki.example.com/sitemap.xml?page=2')

    const seenLocs = new Set<string>()
    let sawFirstPage = false
    let sawLastPage = false
    childUrls.forEach((url, i) => {
      const pageNumber = i + 1
      const child = paginateSitemap('https://wiki.example.com', pages, null, pageNumber)
      assert.ok('xml' in child)
      const childXml = (child as { xml: string }).xml
      assert.doesNotMatch(childXml, /<sitemapindex/)
      const urlCount = (childXml.match(/<url>/g) ?? []).length
      assert.ok(urlCount > 0 && urlCount <= 50_000, `child ${pageNumber} has ${urlCount} urls`)
      for (const loc of childXml.matchAll(/<loc>(.*?)<\/loc>/g)) {
        assert.ok(!seenLocs.has(loc[1]!), `duplicate <loc> across children: ${loc[1]}`)
        seenLocs.add(loc[1]!)
      }
      if (childXml.includes('<loc>https://wiki.example.com/page-000000</loc>')) sawFirstPage = true
      const lastPath = String(total - 1).padStart(6, '0')
      if (childXml.includes(`<loc>https://wiki.example.com/page-${lastPath}</loc>`)) {
        sawLastPage = true
      }
    })
    // -> Every real page path shows up exactly once across the whole paginated set, none dropped by
    //    the split
    assert.equal(seenLocs.size, total)
    assert.ok(sawFirstPage && sawLastPage)

    // -> A page number outside [1, chunk count] is a 404, unlike the under-cap case above
    assert.deepEqual(paginateSitemap('https://wiki.example.com', pages, null, 0), {
      notFound: true
    })
    assert.deepEqual(paginateSitemap('https://wiki.example.com', pages, null, 3), {
      notFound: true
    })
    assert.deepEqual(paginateSitemap('https://wiki.example.com', pages, null, Number.NaN), {
      notFound: true
    })
  })
})
