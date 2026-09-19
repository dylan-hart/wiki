import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import { apiKeySitePinHook, enforceApiKeySite, isBearerAuthenticatedPath } from './apiKeySite.ts'
import pagesRoutes from '../api/pages/index.ts'
import assetsRoutes from '../api/assets.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

/**
 * `enforceApiKeySite` writes the 403 itself via `reply.forbidden()`, so it runs against a real
 * fastify instance with `@fastify/sensible` registered rather than a reply stub.
 */

const SITE_A = '11111111-1111-4111-8111-111111111111'
const SITE_B = '22222222-2222-4222-8222-222222222222'

describe('isBearerAuthenticatedPath', () => {
  test('matches /_api/ requests', () => {
    assert.equal(isBearerAuthenticatedPath('/_api/sites/current'), true)
  })

  test('matches the hostname-resolved public controllers this closes the gap for', () => {
    assert.equal(isBearerAuthenticatedPath('/_files/some/asset.png'), true)
    assert.equal(isBearerAuthenticatedPath('/_site/current/logo'), true)
    assert.equal(isBearerAuthenticatedPath(`/_thumb/${SITE_A}.webp`), true)
    assert.equal(isBearerAuthenticatedPath(`/_pages/${SITE_A}/script.js`), true)
  })

  test('does not match a bare prefix with no trailing slash', () => {
    assert.equal(isBearerAuthenticatedPath('/_files'), false)
    assert.equal(isBearerAuthenticatedPath('/_site'), false)
    assert.equal(isBearerAuthenticatedPath('/_thumb'), false)
    assert.equal(isBearerAuthenticatedPath('/_pages'), false)
  })

  test('does not match controllers/render.ts, which resolves no site and carries no API key', () => {
    assert.equal(isBearerAuthenticatedPath('/_render/'), false)
  })

  test('does not match controllers/icons.ts, which never reads req.apiKey', () => {
    assert.equal(isBearerAuthenticatedPath('/_icons/mdi.json'), false)
  })

  test('does not match an unrelated root-level path', () => {
    assert.equal(isBearerAuthenticatedPath('/robots.txt'), false)
    assert.equal(isBearerAuthenticatedPath('/'), false)
  })
})

describe('enforceApiKeySite — the comparison itself', () => {
  let app: FastifyInstance

  before(async () => {
    app = fastify()
    await app.register(fastifySensible)
    app.get<{ Params: { siteId: string } }>(
      '/probe/:siteId',
      {
        preHandler: (req, _reply) => {
          const scoped = req.headers['x-scoped-site']
          ;(req as any).apiKey = scoped
            ? { id: 'key-1', permissions: [], siteId: scoped }
            : req.headers['x-no-key']
              ? null
              : { id: 'key-1', permissions: [], siteId: null }
          return Promise.resolve()
        }
      },
      async (req, reply) => {
        if (!enforceApiKeySite(req, reply, req.params.siteId)) {
          return reply
        }
        return { ok: true }
      }
    )
    await app.ready()
  })

  after(async () => {
    await app.close()
  })

  test('lets the request through when the key is unscoped (siteId: null)', async () => {
    const res = await app.inject({ method: 'GET', url: `/probe/${SITE_A}` })
    assert.equal(res.statusCode, 200)
  })

  test('lets the request through when the key is not present at all', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/probe/${SITE_A}`,
      headers: { 'x-no-key': '1' }
    })
    assert.equal(res.statusCode, 200)
  })

  test('lets the request through when the scoped site matches the resource site', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/probe/${SITE_A}`,
      headers: { 'x-scoped-site': SITE_A }
    })
    assert.equal(res.statusCode, 200)
  })

  test('refuses with 403 when the scoped site does not match the resource site', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/probe/${SITE_A}`,
      headers: { 'x-scoped-site': SITE_B }
    })
    assert.equal(res.statusCode, 403)
  })
})

describe('apiKeySitePinHook — global coverage, no per-route wiring required', () => {
  let app: FastifyInstance
  const capturedSiteRoutes: { method: string; url: string }[] = []

  before(async () => {
    // -> Off, or the HEAD sibling Fastify generates for every GET would be captured as a second
    //    route under the same URL.
    app = fastify({ exposeHeadRoutes: false })
    await app.register(fastifySensible)

    // -> Fastify has no public API to enumerate routes afterwards, so each is captured as added.
    app.addHook('onRoute', (routeOptions) => {
      if (routeOptions.url.includes(':siteId')) {
        capturedSiteRoutes.push({ method: String(routeOptions.method), url: routeOptions.url })
      }
    })

    app.addHook('onRequest', async (req) => {
      const rawKey = req.headers['x-test-api-key']
      if (typeof rawKey === 'string') {
        ;(req as any).apiKey = JSON.parse(rawKey)
      }
    })

    app.addHook('preHandler', apiKeySitePinHook)

    app.get<{ Params: { siteId: string } }>('/_api/sites/:siteId/ordinary', async () => ({
      ok: true
    }))
    // -> Stands in for a route added later, which nobody wired a site-pin check into.
    app.get<{ Params: { siteId: string; extra: string } }>(
      '/_api/sites/:siteId/newly-added/:extra',
      async () => ({ ok: true })
    )
    app.get('/probe/health', async () => ({ ok: true }))

    await app.ready()
  })

  after(async () => {
    await app.close()
  })

  function apiKeyHeader(siteId: string | null) {
    return { 'x-test-api-key': JSON.stringify({ id: 'key-1', permissions: [], siteId }) }
  }

  test('captured exactly the routes that carry a :siteId param', () => {
    assert.deepEqual(capturedSiteRoutes.map((r) => r.url).sort(), [
      '/_api/sites/:siteId/newly-added/:extra',
      '/_api/sites/:siteId/ordinary'
    ])
  })

  test('every captured :siteId route refuses a mismatched pin, with no per-route wiring', async () => {
    for (const { method, url } of capturedSiteRoutes) {
      const target = url.replace(':siteId', SITE_A).replace(':extra', 'x')
      const res = await app.inject({
        method: method as any,
        url: target,
        headers: apiKeyHeader(SITE_B)
      })
      assert.equal(res.statusCode, 403, `${method} ${url} did not refuse a mismatched pin`)
    }
  })

  test('every captured :siteId route passes through a matching pin', async () => {
    for (const { method, url } of capturedSiteRoutes) {
      const target = url.replace(':siteId', SITE_A).replace(':extra', 'x')
      const res = await app.inject({
        method: method as any,
        url: target,
        headers: apiKeyHeader(SITE_A)
      })
      assert.equal(res.statusCode, 200, `${method} ${url} refused a matching pin`)
    }
  })

  test('a route with no :siteId param is unaffected by any pin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/probe/health',
      headers: apiKeyHeader(SITE_B)
    })
    assert.equal(res.statusCode, 200)
  })
})

/**
 * `getPage` is stubbed to return `null`, so a request that clears the site-pin gate lands on the
 * ordinary 404 -- proof it passed, with no full `Page#` stand-in needed. An asset upload past the
 * gate answers 401 instead: the route requires a session, which an API key is not.
 */
describe('apiKeySitePinHook — real page and asset routes', () => {
  let app: FastifyInstance
  let getPageCalls: any[] = []
  let deletePageCalls: any[] = []

  before(async () => {
    app = await buildTestApp({
      routes: [
        { plugin: pagesRoutes, prefix: '/_api' },
        { plugin: assetsRoutes, prefix: '/_api' }
      ],
      apiKeySitePin: true,
      session: 'header',
      wiki: {
        config: { security: {} },
        models: {
          pages: {
            getPage: async (args: any) => {
              getPageCalls.push(args)
              return null
            },
            deletePage: async (...args: any[]) => {
              deletePageCalls.push(args)
              return true
            }
          },
          groups: {
            actorForRequest: () => ({ permissions: [] }),
            checkAccess: () => true,
            groupIdsForRequest: () => []
          },
          // -> The upload route's `limitUploads` preHandler consumes this on every request.
          rateLimits: {
            consume: async () => ({ allowed: true, hits: 1, retryAfter: 0 })
          }
        }
      }
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    getPageCalls = []
    deletePageCalls = []
  })

  /** A key with a `userId` is its own actor (`actorFrom`), so the page routes need no session. */
  function apiKeyHeader(siteId: string | null) {
    return {
      'x-test-api-key': JSON.stringify({
        id: 'key-1',
        userId: 'user-1',
        permissions: [],
        groupIds: [],
        scope: null,
        allowedClassifications: null,
        siteId
      })
    }
  }

  const PAGE_ID = '33333333-3333-4333-8333-333333333333'

  test('PATCH page: refuses with 403 before touching the model when the key is pinned to a different site', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/_api/sites/${SITE_A}/pages/${PAGE_ID}`,
      headers: apiKeyHeader(SITE_B),
      payload: {}
    })
    assert.equal(res.statusCode, 403)
    assert.equal(getPageCalls.length, 0)
  })

  test('PATCH page: reaches the model when the key is pinned to the matching site', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/_api/sites/${SITE_A}/pages/${PAGE_ID}`,
      headers: apiKeyHeader(SITE_A),
      payload: {}
    })
    assert.equal(res.statusCode, 404)
    assert.equal(getPageCalls.length, 1)
  })

  test('PATCH page: reaches the model when the key is unscoped (siteId: null)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/_api/sites/${SITE_A}/pages/${PAGE_ID}`,
      headers: apiKeyHeader(null),
      payload: {}
    })
    assert.equal(res.statusCode, 404)
    assert.equal(getPageCalls.length, 1)
  })

  test('DELETE page: refuses with 403 before touching the model when the key is pinned to a different site', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/_api/sites/${SITE_A}/pages/${PAGE_ID}`,
      headers: apiKeyHeader(SITE_B)
    })
    assert.equal(res.statusCode, 403)
    assert.equal(getPageCalls.length, 0)
    assert.equal(deletePageCalls.length, 0)
  })

  test('DELETE page: reaches the model when the key is pinned to the matching site', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/_api/sites/${SITE_A}/pages/${PAGE_ID}`,
      headers: apiKeyHeader(SITE_A)
    })
    assert.equal(res.statusCode, 404)
    assert.equal(getPageCalls.length, 1)
  })

  test('DELETE page: reaches the model when the key is unscoped (siteId: null)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/_api/sites/${SITE_A}/pages/${PAGE_ID}`,
      headers: apiKeyHeader(null)
    })
    assert.equal(res.statusCode, 404)
    assert.equal(getPageCalls.length, 1)
  })

  test('asset upload: refuses with 403 before touching authentication when the key is pinned to a different site', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/_api/sites/${SITE_A}/assets?fileName=test.png`,
      headers: { ...apiKeyHeader(SITE_B), 'content-type': 'image/png' },
      payload: Buffer.from([1, 2, 3])
    })
    assert.equal(res.statusCode, 403)
  })

  test('asset upload: passes the gate and reaches the ordinary auth check when the key is pinned to the matching site', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/_api/sites/${SITE_A}/assets?fileName=test.png`,
      headers: { ...apiKeyHeader(SITE_A), 'content-type': 'image/png' },
      payload: Buffer.from([1, 2, 3])
    })
    assert.equal(res.statusCode, 401)
  })

  test('asset upload: passes the gate and reaches the ordinary auth check when the key is unscoped', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/_api/sites/${SITE_A}/assets?fileName=test.png`,
      headers: { ...apiKeyHeader(null), 'content-type': 'image/png' },
      payload: Buffer.from([1, 2, 3])
    })
    assert.equal(res.statusCode, 401)
  })
})

/**
 * `getPage` returns `null` here too, so clearing the gate reads as a 404. This `apiKeyHeader()` omits
 * `userId`, unlike the one above: the last test relies on an unscoped, session-less create being
 * refused by the ordinary unauthenticated check rather than by the site-pin gate.
 */
describe('pages API — apiKeySitePinHook site-scoping', () => {
  const PAGE_HASH = 'ab'.repeat(16)

  let getPageCalls: any[] = []
  let createPageCalls: any[] = []

  let app: FastifyInstance

  before(async () => {
    app = await buildTestApp({
      // -> The hook only checks `/_api/sites/...`, so mounting bare would silently exercise nothing.
      routes: pagesRoutes,
      prefix: '/_api',
      apiKeySitePin: true,
      session: 'header',
      wiki: {
        models: {
          pages: {
            getPage: async (args: any) => {
              getPageCalls.push(args)
              return null
            },
            createPage: async (...args: any[]) => {
              createPageCalls.push(args)
              return { id: 'new-page-id' }
            }
          },
          groups: {
            actorForRequest: () => ({ permissions: [] }),
            checkAccess: () => true,
            groupIdsForRequest: () => []
          }
        }
      }
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    getPageCalls = []
    createPageCalls = []
  })

  function apiKeyHeader(siteId: string | null) {
    return { 'x-test-api-key': JSON.stringify({ id: 'key-1', permissions: [], siteId }) }
  }

  test('GET page: refuses with 403 before touching the model when the key is scoped to a different site', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/_api/sites/${SITE_A}/pages/${PAGE_HASH}`,
      headers: apiKeyHeader(SITE_B)
    })
    assert.equal(res.statusCode, 403)
    assert.equal(getPageCalls.length, 0)
  })

  test('GET page: reaches the model when the key is scoped to the matching site', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/_api/sites/${SITE_A}/pages/${PAGE_HASH}`,
      headers: apiKeyHeader(SITE_A)
    })
    assert.equal(res.statusCode, 404)
    assert.equal(getPageCalls.length, 1)
  })

  test('GET page: reaches the model when the key is unscoped (siteId: null)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/_api/sites/${SITE_A}/pages/${PAGE_HASH}`,
      headers: apiKeyHeader(null)
    })
    assert.equal(res.statusCode, 404)
    assert.equal(getPageCalls.length, 1)
  })

  test('CREATE page: refuses with 403 before touching the model when the key is scoped to a different site', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/_api/sites/${SITE_A}/pages`,
      headers: apiKeyHeader(SITE_B),
      payload: { path: 'test-page', title: 'Test', editor: 'markdown', content: 'hello' }
    })
    assert.equal(res.statusCode, 403)
    assert.equal(createPageCalls.length, 0)
  })

  test('CREATE page: passes the gate and reaches the model when the key is scoped to the matching site', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/_api/sites/${SITE_A}/pages`,
      headers: {
        ...apiKeyHeader(SITE_A),
        'x-test-session': JSON.stringify({
          authenticated: true,
          user: { id: 'user-1' },
          permissions: []
        })
      },
      payload: { path: 'test-page', title: 'Test', editor: 'markdown', content: 'hello' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(createPageCalls.length, 1)
  })

  test('CREATE page: refused by the ordinary unauthenticated check, not the site gate, when the key is unscoped and there is no session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/_api/sites/${SITE_A}/pages`,
      headers: apiKeyHeader(null),
      payload: { path: 'test-page', title: 'Test', editor: 'markdown', content: 'hello' }
    })
    assert.equal(res.statusCode, 401)
    assert.equal(createPageCalls.length, 0)
  })
})

/**
 * A representative slice of the surface; `apiKeySite.coverage.test.ts` checks the whole registered
 * route table structurally.
 */
describe('apiKeySitePinHook', () => {
  let hookApp: FastifyInstance

  before(async () => {
    hookApp = fastify()
    await hookApp.register(fastifySensible)
    hookApp.addHook('preHandler', (req, _reply, done) => {
      const scoped = req.headers['x-scoped-site']
      ;(req as any).apiKey = scoped
        ? { id: 'key-1', permissions: [], siteId: scoped }
        : req.headers['x-no-key']
          ? null
          : { id: 'key-1', permissions: [], siteId: null }
      done()
    })
    hookApp.addHook('preHandler', apiKeySitePinHook)

    hookApp.get<{ Params: { siteId: string } }>('/_api/sites/:siteId/pages/:pageId', async () => ({
      ok: true
    }))
    hookApp.patch<{ Params: { siteId: string; pageId: string } }>(
      '/_api/sites/:siteId/pages/:pageId',
      async () => ({ ok: true })
    )
    hookApp.delete<{ Params: { siteId: string; pageId: string } }>(
      '/_api/sites/:siteId/pages/:pageId',
      async () => ({ ok: true })
    )
    hookApp.post<{ Params: { siteId: string } }>('/_api/sites/:siteId/assets', async () => ({
      ok: true
    }))
    // -> Same param name, deliberately outside `/_api/sites/`: `controllers/site.ts`'s route shape,
    //    whose `:siteId` can be the sentinel `'current'` rather than a real site id.
    hookApp.get<{ Params: { siteId: string; resource: string } }>(
      '/_site/:siteId/:resource',
      async () => ({ ok: true })
    )
    await hookApp.ready()
  })

  after(async () => {
    await hookApp.close()
  })

  for (const [method, url] of [
    ['GET', `/_api/sites/${SITE_A}/pages/some-page`],
    ['PATCH', `/_api/sites/${SITE_A}/pages/some-page`],
    ['DELETE', `/_api/sites/${SITE_A}/pages/some-page`],
    ['POST', `/_api/sites/${SITE_A}/assets`]
  ] as const) {
    test(`${method}: refuses with 403 when the key is pinned to a different site`, async () => {
      const res = await hookApp.inject({
        method,
        url,
        headers: { 'x-scoped-site': SITE_B }
      })
      assert.equal(res.statusCode, 403)
    })

    test(`${method}: lets an unpinned (null siteId) key through`, async () => {
      const res = await hookApp.inject({ method, url })
      assert.equal(res.statusCode, 200)
    })

    test(`${method}: lets a key pinned to the matching site through`, async () => {
      const res = await hookApp.inject({
        method,
        url,
        headers: { 'x-scoped-site': SITE_A }
      })
      assert.equal(res.statusCode, 200)
    })
  }

  test('does not touch a route outside /_api/sites/ that happens to share the :siteId param name', async () => {
    const res = await hookApp.inject({
      method: 'GET',
      url: '/_site/current/logo',
      headers: { 'x-scoped-site': SITE_A }
    })
    // -> A hook matching on the param name would answer 403: 'current' never equals SITE_A.
    assert.equal(res.statusCode, 200)
  })
})
