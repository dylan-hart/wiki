import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import { apiKeySitePinHook, enforceApiKeySite } from './apiKeySite.ts'
import pagesRoutes from '../api/pages.ts'
import assetsRoutes from '../api/assets.ts'
import { registerSchemas as registerAssetSchema } from '../api/schemas/asset.ts'
import { registerSchemas as registerApprovalSchemas } from '../api/schemas/approval.ts'
import { registerSchemas as registerErrorSchema } from '../api/schemas/error.ts'
import { registerSchemas as registerPageImportSchema } from '../api/schemas/pageImport.ts'
import { registerSchemas as registerPageSchema } from '../api/schemas/page.ts'

/**
 * `enforceApiKeySite` writes the 403 itself via `reply.forbidden()`, so — like `limitApiKey` in
 * `rateLimit.test.ts` — it is exercised against a real fastify instance with `@fastify/sensible`
 * registered rather than a hand-rolled reply stub.
 */

const SITE_A = '11111111-1111-4111-8111-111111111111'
const SITE_B = '22222222-2222-4222-8222-222222222222'

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

    app.get<{ Params: { siteId: string } }>('/probe/sites/:siteId/ordinary', async () => ({
      ok: true
    }))
    // -> Stands in for a route nobody wired an explicit site-pin check into -- proving the hook covers
    //    it anyway, which is the whole point of making this global rather than per-route.
    app.get<{ Params: { siteId: string; extra: string } }>(
      '/probe/sites/:siteId/newly-added/:extra',
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
      '/probe/sites/:siteId/newly-added/:extra',
      '/probe/sites/:siteId/ordinary'
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
    ;(globalThis as any).WIKI = {
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
      },
      sites: {}
    }

    app = fastify()
    await app.register(fastifySensible)
    // -> Mirrors `index.ts`'s real `setErrorHandler`: a `reply.notFound()`/`forbidden()`/etc. is a
    //    thrown `@fastify/sensible` error, and it is THIS handler -- not fastify's default -- that
    //    shapes it into the `{ ok, error, statusCode, message }` the `ApiError` schema expects.
    app.setErrorHandler((error: any, _req, reply) => {
      reply.code(error.statusCode ?? 500).send({
        ok: false,
        error: error.name,
        statusCode: error.statusCode ?? 500,
        message: error.message
      })
    })
    app.addHook('onRequest', async (req) => {
      const rawKey = req.headers['x-test-api-key']
      if (typeof rawKey === 'string') {
        ;(req as any).apiKey = JSON.parse(rawKey)
      }
    })
    app.addHook('preHandler', apiKeySitePinHook)

    await registerApprovalSchemas(app)
    await registerPageSchema(app)
    await registerErrorSchema(app)
    await registerPageImportSchema(app)
    await registerAssetSchema(app)
    await app.register(pagesRoutes)
    await app.register(assetsRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  beforeEach(() => {
    getPageCalls = []
    deletePageCalls = []
  })

  /** An API key with a `userId` acts as its own actor (`actorFrom` in `api/pages.ts`) -- no session needed. */
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
      url: `/sites/${SITE_A}/pages/${PAGE_ID}`,
      headers: apiKeyHeader(SITE_B),
      payload: {}
    })
    assert.equal(res.statusCode, 403)
    assert.equal(getPageCalls.length, 0)
  })

  test('PATCH page: reaches the model when the key is pinned to the matching site', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_A}/pages/${PAGE_ID}`,
      headers: apiKeyHeader(SITE_A),
      payload: {}
    })
    assert.equal(res.statusCode, 404) // -> past the gate, into the ordinary "page not found" path
    assert.equal(getPageCalls.length, 1)
  })

  test('PATCH page: reaches the model when the key is unscoped (siteId: null)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_A}/pages/${PAGE_ID}`,
      headers: apiKeyHeader(null),
      payload: {}
    })
    assert.equal(res.statusCode, 404)
    assert.equal(getPageCalls.length, 1)
  })

  test('DELETE page: refuses with 403 before touching the model when the key is pinned to a different site', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/sites/${SITE_A}/pages/${PAGE_ID}`,
      headers: apiKeyHeader(SITE_B)
    })
    assert.equal(res.statusCode, 403)
    assert.equal(getPageCalls.length, 0)
    assert.equal(deletePageCalls.length, 0)
  })

  test('DELETE page: reaches the model when the key is pinned to the matching site', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/sites/${SITE_A}/pages/${PAGE_ID}`,
      headers: apiKeyHeader(SITE_A)
    })
    assert.equal(res.statusCode, 404) // -> getPage stub returns null, so this is "page not found"
    assert.equal(getPageCalls.length, 1)
  })

  test('DELETE page: reaches the model when the key is unscoped (siteId: null)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/sites/${SITE_A}/pages/${PAGE_ID}`,
      headers: apiKeyHeader(null)
    })
    assert.equal(res.statusCode, 404)
    assert.equal(getPageCalls.length, 1)
  })

  test('asset upload: refuses with 403 before touching authentication when the key is pinned to a different site', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_A}/assets?fileName=test.png`,
      headers: { ...apiKeyHeader(SITE_B), 'content-type': 'image/png' },
      payload: Buffer.from([1, 2, 3])
    })
    assert.equal(res.statusCode, 403)
  })

  test('asset upload: passes the gate and reaches the ordinary auth check when the key is pinned to the matching site', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_A}/assets?fileName=test.png`,
      headers: { ...apiKeyHeader(SITE_A), 'content-type': 'image/png' },
      payload: Buffer.from([1, 2, 3])
    })
    // -> Past the site-pin gate: an API key carries no session, and uploading requires one.
    assert.equal(res.statusCode, 401)
  })

  test('asset upload: passes the gate and reaches the ordinary auth check when the key is unscoped', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_A}/assets?fileName=test.png`,
      headers: { ...apiKeyHeader(null), 'content-type': 'image/png' },
      payload: Buffer.from([1, 2, 3])
    })
    assert.equal(res.statusCode, 401)
  })
})
