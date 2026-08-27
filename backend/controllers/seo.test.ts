import { after, afterEach, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import seoRoutes, { buildRobotsTxt, buildSitemapXml } from './seo.ts'
import { invalidateSitemapCache } from '../helpers/sitemapCache.ts'
import { createCacheStub } from '../test/mocks.ts'

/**
 * `buildRobotsTxt`/`buildSitemapXml` below are pure content-generation logic — no `WIKI` global, no
 * database, no Fastify instance. Everything that decides what a request gets before reaching them
 * (site resolution, the `sitemap` gate, `listPagesForSitemap`'s guest-rule filtering) is exercised
 * where it actually lives: `models/pages.test.ts` for the query.
 *
 * The `GET /sitemap.xml` caching describe block further down (OpenProject #2267) DOES register the
 * real route plugin against `app.inject`, same as `controllers/site.test.ts` — `WIKI.models.pages
 * .listPagesForSitemap` is stubbed as a `mock.fn` so the test can assert on how many times the
 * (expensive) query actually ran, and `WIKI.cache` is `test/mocks.ts`'s real `createCacheStub()`
 * rather than a bespoke stand-in, so the route exercises the same cache surface (`get`/`set`/`has`/
 * `delete`, millisecond `ttl`) it would in production.
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

describe('GET /sitemap.xml — per-site caching (OpenProject #2267)', () => {
  const SITE = {
    id: 'site-sitemap-cache',
    hostname: 'wiki.example.com',
    config: { sitemap: true, locales: null }
  }

  const SITEMAP_PAGES = [
    { path: 'docs/one', locale: 'en', updatedAt: new Date('2026-01-01T00:00:00Z') }
  ]

  let app: FastifyInstance
  let listPagesForSitemap: ReturnType<typeof mock.fn>

  before(async () => {
    listPagesForSitemap = mock.fn(async () => SITEMAP_PAGES)
    ;(globalThis as any).WIKI = {
      cache: createCacheStub(),
      models: {
        sites: { getSiteByHostname: async () => SITE },
        pages: { listPagesForSitemap }
      }
    }

    app = fastify()
    await app.register(fastifySensible)
    await app.register(seoRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  afterEach(() => {
    listPagesForSitemap.mock.resetCalls()
    // -> Each test starts from an empty cache, not whatever the previous test left cached for this
    //    same siteId
    ;(WIKI.cache as any).clear()
  })

  test('sets a public, max-age Cache-Control header on the response', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sitemap.xml',
      headers: { host: SITE.hostname }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['cache-control'], 'public, max-age=300')
  })

  test('a second request inside the TTL performs no page query, and serves the same body', async () => {
    const first = await app.inject({
      method: 'GET',
      url: '/sitemap.xml',
      headers: { host: SITE.hostname }
    })
    assert.equal(listPagesForSitemap.mock.calls.length, 1)

    const second = await app.inject({
      method: 'GET',
      url: '/sitemap.xml',
      headers: { host: SITE.hostname }
    })
    assert.equal(
      listPagesForSitemap.mock.calls.length,
      1,
      'the cached body must serve the second hit'
    )
    assert.equal(second.body, first.body)
  })

  test('the cached body is dropped on a page publish, so the next request re-queries', async () => {
    await app.inject({ method: 'GET', url: '/sitemap.xml', headers: { host: SITE.hostname } })
    assert.equal(listPagesForSitemap.mock.calls.length, 1)

    // -> Stands in for `models/pages.ts`'s own call on create/update/move/delete -- the exact
    //    function it imports from `helpers/sitemapCache.ts`
    invalidateSitemapCache(SITE.id)

    await app.inject({ method: 'GET', url: '/sitemap.xml', headers: { host: SITE.hostname } })
    assert.equal(
      listPagesForSitemap.mock.calls.length,
      2,
      'a dropped cache entry must force a fresh query'
    )
  })

  test("a different baseUrl for the same siteId is treated as a cache miss, not served the wrong hostname's body", async () => {
    await app.inject({ method: 'GET', url: '/sitemap.xml', headers: { host: SITE.hostname } })
    assert.equal(listPagesForSitemap.mock.calls.length, 1)

    // -> Same siteId (the catch-all `*` site can be reached through more than one hostname), but a
    //    different `${protocol}://${hostname}` -- must not serve the first hostname's cached <loc>s
    await app.inject({
      method: 'GET',
      url: '/sitemap.xml',
      headers: { host: 'other.example.com' }
    })
    assert.equal(listPagesForSitemap.mock.calls.length, 2)
  })
})
