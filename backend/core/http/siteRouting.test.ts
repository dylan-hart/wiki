import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import Fastify from 'fastify'

import {
  isPageUrl,
  registerSeoRedirects,
  RESERVED_ROOT_FILES,
  SERVER_ROUTE_SEGMENTS
} from './siteRouting.ts'
import { installTestWiki } from '../../test/mocks.ts'

describe('isPageUrl', () => {
  test('a plain page path addresses the page tree', () => {
    assert.equal(isPageUrl('/home'), true)
    assert.equal(isPageUrl('/docs/getting-started'), true)
    assert.equal(isPageUrl('/'), true)
  })

  test('every server-owned first segment is excluded', () => {
    for (const segment of SERVER_ROUTE_SEGMENTS) {
      assert.equal(isPageUrl(`/${segment}/anything`), false, `${segment} should not be a page path`)
    }
  })

  test('every reserved root file is excluded, case-insensitively', () => {
    for (const file of RESERVED_ROOT_FILES) {
      assert.equal(isPageUrl(`/${file}`), false, `${file} should not be a page path`)
      assert.equal(isPageUrl(`/${file.toUpperCase()}`), false)
    }
  })

  test("the frontend router's own underscore routes are still not page paths", () => {
    // -> They reach the app shell through `registerAppShellFallback`. The prefix test cannot tell
    //    them apart from `/_api`, which is why `SERVER_ROUTE_SEGMENTS` is spelled out.
    assert.equal(isPageUrl('/_admin/general'), false)
    assert.equal(SERVER_ROUTE_SEGMENTS.has('_admin'), false)
  })
})

describe('SERVER_ROUTE_SEGMENTS', () => {
  test('covers `/_api`, the one prefix every route file under api/ is mounted behind', () => {
    // -> A cheap floor rather than a full cross-check against `core/http/routes.ts`: with `/_api`
    //    dropped, an unmatched API path would answer with the app shell instead of a 404.
    assert.equal(SERVER_ROUTE_SEGMENTS.has('_api'), true)
  })

  test('every entry is an underscore-prefixed single segment', () => {
    for (const segment of SERVER_ROUTE_SEGMENTS) {
      assert.match(segment, /^_[a-z]+$/, `${segment} should be one underscore-prefixed segment`)
    }
  })
})

describe('RESERVED_ROOT_FILES', () => {
  test('holds exactly the unprefixed root paths the server answers itself', () => {
    assert.deepEqual([...RESERVED_ROOT_FILES].sort(), [
      'favicon.ico',
      'metrics',
      'robots.txt',
      'sitemap.xml'
    ])
  })

  test('is stored lowercase, since isPageUrl lowercases before looking up', () => {
    for (const file of RESERVED_ROOT_FILES) {
      assert.equal(file, file.toLowerCase())
    }
  })
})

describe('registerSeoRedirects locale aliases', () => {
  async function redirectFor(url: string, locales: Record<string, unknown>) {
    const handle = installTestWiki({
      sitesMappings: { '*': 'site-1' },
      sites: { 'site-1': { config: { locales } } }
    })
    const app = Fastify()
    registerSeoRedirects(app)
    app.get('/*', async () => 'ok')
    try {
      const res = await app.inject({ method: 'GET', url })
      return { status: res.statusCode, location: res.headers.location }
    } finally {
      await app.close()
      handle.restore()
    }
  }

  const base = { primary: 'en', active: ['en', 'zh-CN'], forcePrefix: false }
  const aliased = { ...base, aliases: { 'zh-CN': 'zh' } }

  test('302s the canonical spelling to the alias and keeps the query string', async () => {
    assert.deepEqual(await redirectFor('/zh-CN/page?a=1', aliased), {
      status: 302,
      location: '/zh/page?a=1'
    })
  })

  test('leaves the alias spelling alone', async () => {
    assert.deepEqual(await redirectFor('/zh/page', aliased), { status: 200, location: undefined })
  })

  test('re-cases a mis-cased alias', async () => {
    assert.deepEqual(await redirectFor('/ZH/page', aliased), {
      status: 302,
      location: '/zh/page'
    })
  })

  test('forcePrefix sends a bare path to the primary locale alias, then settles', async () => {
    const cfg = { ...aliased, forcePrefix: true, aliases: { en: 'e', 'zh-CN': 'zh' } }
    assert.deepEqual(await redirectFor('/page', cfg), { status: 302, location: '/e/page' })
    assert.deepEqual(await redirectFor('/e/page', cfg), { status: 200, location: undefined })
    assert.deepEqual(await redirectFor('/en/page', cfg), { status: 302, location: '/e/page' })
  })

  test('without aliases the canonical spelling is untouched', async () => {
    assert.deepEqual(await redirectFor('/zh-CN/page', base), { status: 200, location: undefined })
  })
})
