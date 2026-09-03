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
 * `enforceApiKeySite` writes the 403 itself via `reply.forbidden()`, so — like `limitApiKey` in
 * `rateLimit.test.ts` — it is exercised against a real fastify instance with `@fastify/sensible`
 * registered rather than a hand-rolled reply stub.
 */

const SITE_A = '11111111-1111-4111-8111-111111111111'
const SITE_B = '22222222-2222-4222-8222-222222222222'

/**
 * OpenProject #2339: `index.ts`'s Bearer-verification hook only ever populated `req.apiKey` for
 * `/_api/` requests, which made `enforceApiKeySite()`'s calls in `controllers/files.ts` and
 * `controllers/site.ts` (and the equivalent `actorForRequest()`-mediated check in
 * `controllers/thumb.ts`) permanent no-ops -- a valid, site-pinned Bearer token sent to any of those
 * three routes was silently ignored rather than verified. `isBearerAuthenticatedPath` is the pure
 * function of the URL that decides whether the hook should even look for a token; this proves it
 * covers exactly the intended surface and nothing more.
 */
describe('isBearerAuthenticatedPath', () => {
  test('matches /_api/ requests', () => {
    assert.equal(isBearerAuthenticatedPath('/_api/sites/current'), true)
  })

  test('matches the three hostname-resolved public controllers this closes the gap for', () => {
    assert.equal(isBearerAuthenticatedPath('/_files/some/asset.png'), true)
    assert.equal(isBearerAuthenticatedPath('/_site/current/logo'), true)
    assert.equal(isBearerAuthenticatedPath(`/_thumb/${SITE_A}.webp`), true)
  })

  test('does not match a bare prefix with no trailing slash', () => {
    assert.equal(isBearerAuthenticatedPath('/_files'), false)
    assert.equal(isBearerAuthenticatedPath('/_site'), false)
    assert.equal(isBearerAuthenticatedPath('/_thumb'), false)
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

/**
 * Task 2194: `apiKeySitePinHook` is what `index.ts` registers as a single global `preHandler`, ahead of
 * every route, rather than each route remembering to call `enforceApiKeySite` itself -- the gap that
 * left 117 of 119 site-addressed routes unguarded before this task. This proves the "no route-specific
 * wiring needed" property directly: two routes are registered against a plain fastify instance the same
 * way index.ts registers real ones, and a third is registered with a `:siteId` in a spot no test (and no
 * hand-maintained allow-list) named ahead of time, standing in for "a route added after this test was
 * written" -- if the hook depended on recognizing specific paths, this one would slip through the way
 * the 117 originally did. A route with no `:siteId` param is included too, to prove the hook only ever
 * acts where there is a site to compare against.
 */
describe('apiKeySitePinHook — global coverage, no per-route wiring required', () => {
  let app: FastifyInstance
  const capturedSiteRoutes: { method: string; url: string }[] = []

  before(async () => {
    // -> `exposeHeadRoutes` off: Fastify's default auto-generates a HEAD sibling for every GET, which
    //    would otherwise double-register (and double-capture) each probe route below under the same
    //    URL, muddying what this test is actually counting.
    app = fastify({ exposeHeadRoutes: false })
    await app.register(fastifySensible)

    // -> Mirrors `analytics.test.ts`'s technique for reading back what was registered: Fastify exposes
    //    no public API to enumerate routes after the fact, so this is captured as each one is added.
    app.addHook('onRoute', (routeOptions) => {
      if (routeOptions.url.includes(':siteId')) {
        capturedSiteRoutes.push({ method: String(routeOptions.method), url: routeOptions.url })
      }
    })

    // -> The one thing every real caller needs: `req.apiKey` populated the same shape
    //    `models/apiKeys.ts#verify()` produces, from a test-only header.
    app.addHook('onRequest', async (req) => {
      const rawKey = req.headers['x-test-api-key']
      if (typeof rawKey === 'string') {
        ;(req as any).apiKey = JSON.parse(rawKey)
      }
    })

    // -> Registered exactly as `index.ts` does: unconditionally, before any route exists.
    app.addHook('preHandler', apiKeySitePinHook)

    app.get<{ Params: { siteId: string } }>('/_api/sites/:siteId/ordinary', async () => ({
      ok: true
    }))
    // -> Stands in for a route nobody wired an explicit site-pin check into -- proving the hook covers
    //    it anyway, which is the whole point of making this global rather than per-route.
    app.get<{ Params: { siteId: string; extra: string } }>(
      '/_api/sites/:siteId/newly-added/:extra',
      async () => ({ ok: true })
    )
    // -> No `:siteId` at all: the hook must leave this alone regardless of the key's pin.
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
 * The same hook wired in front of real routes: `PATCH /sites/:siteId/pages/:pageId`,
 * `DELETE /sites/:siteId/pages/:pageId` and `POST /sites/:siteId/assets` (task 2194's own examples),
 * with real route registration, real schemas, real `@fastify/sensible` `reply.forbidden()` -- proving
 * the global hook actually reaches production routes ahead of any model call, now that neither route
 * calls `enforceApiKeySite` itself any more.
 *
 * `WIKI.models.pages.getPage` / `WIKI.models.pages.deletePage` are stubbed to return `null`, so a
 * request that clears the site-pin gate falls through to the ordinary "page does not exist" 404 --
 * proof the gate was passed without needing a full `Page#`-shaped stand-in. The asset upload route
 * needs no equivalent stub: `actorFrom`'s session check is what stops it next, well before any model
 * call, since uploads require a logged-in session rather than an API key's own user.
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

  /** An API key with a `userId` acts as its own actor (`actorFrom` in `helpers/pageAccess.ts`) -- no session needed. */
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
    assert.equal(res.statusCode, 404) // -> past the gate, into the ordinary "page not found" path
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
    assert.equal(res.statusCode, 404) // -> getPage stub returns null, so this is "page not found"
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
    // -> Past the site-pin gate: an API key carries no session, and uploading requires one.
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
 * Route-wiring proof for `apiKeySitePinHook`, on two representative routes:
 * `GET /_api/sites/:siteId/pages/:pageIdOrHash` and `POST /_api/sites/:siteId/pages`. OpenProject
 * #2194 moved enforcement off these two routes' own per-route `enforceApiKeySite()` calls (deleted)
 * onto the global hook `index.ts` registers alongside the permissions hook — this file registers that
 * same hook directly (not `index.ts` itself, which boots a real database connection) under the same
 * `/_api` prefix it checks, so the routes are exercised exactly as they are wired in production. This
 * describe's own `app` registers only `pagesRoutes` (no `assetsRoutes`), which is why it lives
 * alongside, rather than merged into, "real page and asset routes" above — a different route set
 * needs its own `before()`/`after()`. `req.apiKey` is attached by a fixture `onRequest` hook that
 * reads it off an `x-test-api-key` test header, the same shape `models/apiKeys.ts#verify()` produces
 * at runtime — nothing about the routes themselves is test-specific.
 *
 * `WIKI.models.pages.getPage` is stubbed to return `null` so a request that clears the site-scope gate
 * falls through to the ordinary "page does not exist" 404 — which needs no `Page#` response payload —
 * rather than requiring a full page object satisfying that schema just to prove the gate was passed.
 *
 * This describe's own `apiKeyHeader()` deliberately omits `userId` (unlike the one above): the last
 * test below depends on that, refusing an unscoped, session-less CREATE by the ordinary
 * unauthenticated check rather than the site-pin gate.
 */
describe('pages API — apiKeySitePinHook site-scoping', () => {
  const PAGE_HASH = 'ab'.repeat(16)

  let getPageCalls: any[] = []
  let createPageCalls: any[] = []

  let app: FastifyInstance

  before(async () => {
    app = await buildTestApp({
      // -> `/_api` prefix, matching `api/index.ts`'s real registration -- the hook only checks
      //    `/_api/sites/...` (see its own doc comment), so mounting bare would silently exercise
      //    nothing.
      routes: pagesRoutes,
      prefix: '/_api',
      // -> The REAL hook, at the same stage the real boot registers it (`preHandler`, beside the
      //    permissions hook).
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
    assert.equal(res.statusCode, 404) // -> past the gate, into the ordinary "page not found" path
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
    // -> Past the site-scope gate (unscoped key): refused next by `actorFrom` (no session).
    assert.equal(res.statusCode, 401)
    assert.equal(createPageCalls.length, 0)
  })
})

/**
 * `apiKeySitePinHook` (OpenProject #2194): the global `preHandler` covering every `/_api/sites/:siteId/
 * ...` route in one place, registered once in `index.ts` rather than a call added to each route. Built
 * against a small representative slice of that surface — a GET, a PATCH, a DELETE and an upload-shaped
 * POST, all under the real `/_api/sites/:siteId/...` prefix — rather than the full 175-route table,
 * which `helpers/apiKeySite.coverage.test.ts` covers structurally instead (every real registered route
 * carrying a `:siteId` param really does sit under this prefix, so this hook really does reach it).
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
    // -> Same param NAME, deliberately OUTSIDE `/_api/sites/` -- `controllers/site.ts`'s real route
    //    shape, whose `:siteId` can be the literal sentinel `'current'` rather than a real site id.
    //    The hook must leave it alone; `controllers/site.ts` calls `enforceApiKeySite()` itself once
    //    it has resolved a real site (OpenProject #2201).
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
    // -> Would be 403 if the hook matched on param name alone rather than the URL prefix: 'current'
    //    is never equal to SITE_A. Passing through to the (stubbed, always-200) handler proves the
    //    hook left this route alone, as designed.
    assert.equal(res.statusCode, 200)
  })
})
