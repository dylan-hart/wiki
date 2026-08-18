import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRobotsTxt, buildSitemapXml } from './seo.ts'

/**
 * Pure content-generation logic only — no `WIKI` global, no database, no Fastify instance. Everything
 * that decides what a request gets (site resolution, the `sitemap` gate, `listPagesForSitemap`'s
 * guest-rule filtering) is exercised where it actually lives: `models/pages.test.ts` for the query,
 * and there is no server-boot harness in this repo to run the route registration itself against.
 */

let previousToTemporalInstant: any

/**
 * `buildSitemapXml` reads `Date.prototype.toTemporalInstant()`, which CLAUDE.md documents as a native
 * Node 26 feature needing no import or polyfill — but this sandbox's `node` is v25.9.0, which doesn't
 * expose it (same environment gap `core/scheduler.test.ts` documents for `Temporal.Now.instant()`, not
 * a spec deviation in the code under test). Stubbing just enough of the chain
 * (`toTemporalInstant().toZonedDateTimeISO('UTC').toPlainDate().toString()`) to produce a UTC
 * `YYYY-MM-DD` keeps the test independent of that runtime gap.
 */
before(() => {
  previousToTemporalInstant = (Date.prototype as any).toTemporalInstant
  if (typeof previousToTemporalInstant !== 'function') {
    ;(Date.prototype as any).toTemporalInstant = function (this: Date) {
      const isoDate = this.toISOString().slice(0, 10)
      return {
        toZonedDateTimeISO: () => ({
          toPlainDate: () => ({ toString: () => isoDate })
        })
      }
    }
  }
})

after(() => {
  ;(Date.prototype as any).toTemporalInstant = previousToTemporalInstant
})

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
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>\n'
    )
  })

  test('one <url> per page, with an absolute <loc> and a date-only <lastmod>', () => {
    const xml = buildSitemapXml('https://wiki.example.com', [
      { path: 'docs/getting-started', updatedAt: new Date('2026-03-14T10:30:00Z') }
    ])
    assert.ok(xml.includes('<loc>https://wiki.example.com/docs/getting-started</loc>'))
    assert.ok(xml.includes('<lastmod>2026-03-14</lastmod>'))
  })

  test('lists every page, in order', () => {
    const xml = buildSitemapXml('https://wiki.example.com', [
      { path: 'a', updatedAt: new Date('2026-01-01T00:00:00Z') },
      { path: 'b', updatedAt: new Date('2026-01-02T00:00:00Z') }
    ])
    const locA = xml.indexOf('<loc>https://wiki.example.com/a</loc>')
    const locB = xml.indexOf('<loc>https://wiki.example.com/b</loc>')
    assert.ok(locA >= 0 && locB >= 0)
    assert.ok(locA < locB)
  })

  test('escapes XML-significant characters in the base URL', () => {
    const xml = buildSitemapXml('https://wiki.example.com/a&b', [
      { path: 'x', updatedAt: new Date('2026-01-01T00:00:00Z') }
    ])
    assert.ok(xml.includes('<loc>https://wiki.example.com/a&amp;b/x</loc>'))
    assert.ok(!xml.includes('a&b/x'))
  })
})
