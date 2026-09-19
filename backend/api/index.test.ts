import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import apiRoutes from './index.ts'
import { buildTestApp, closeTestApp, makeDoneStub, makeReplyStub } from '../test/fastify.ts'
import { installTestWiki } from '../test/mocks.ts'
import { listApiRouteFiles, recordRoutesFrom } from '../test/routeRecorder.ts'
import {
  siteEnabledPreHandler,
  SITE_DISABLED_MESSAGE,
  SITE_MISSING_MESSAGE
} from '../helpers/siteResolution.ts'

describe('siteEnabledPreHandler', () => {
  const ENABLED_SITE_ID = '11111111-1111-4111-8111-111111111111'
  const DISABLED_SITE_ID = '22222222-2222-4222-8222-222222222222'
  const UNKNOWN_SITE_ID = '99999999-9999-4999-8999-999999999999'

  const sites: Record<string, any> = {
    [ENABLED_SITE_ID]: { id: ENABLED_SITE_ID, isEnabled: true },
    [DISABLED_SITE_ID]: { id: DISABLED_SITE_ID, isEnabled: false }
  }

  let wikiHandle: { restore(): void }

  before(() => {
    wikiHandle = installTestWiki({ sites })
  })

  after(() => {
    wikiHandle.restore()
  })

  test('a route with no siteId param passes through untouched', () => {
    const { reply, calls } = makeReplyStub()
    const stub = makeDoneStub()
    siteEnabledPreHandler({ params: {} } as any, reply, stub.done)
    assert.equal(stub.called, true)
    assert.deepEqual(calls.forbidden, [])
    assert.deepEqual(calls.notFound, [])
  })

  test('an enabled site passes through', () => {
    const { reply, calls } = makeReplyStub()
    const stub = makeDoneStub()
    siteEnabledPreHandler({ params: { siteId: ENABLED_SITE_ID } } as any, reply, stub.done)
    assert.equal(stub.called, true)
    assert.deepEqual(calls.forbidden, [])
    assert.deepEqual(calls.notFound, [])
  })

  test('a disabled site is refused 403 and never reaches done()', () => {
    const { reply, calls } = makeReplyStub()
    const stub = makeDoneStub()
    siteEnabledPreHandler({ params: { siteId: DISABLED_SITE_ID } } as any, reply, stub.done)
    assert.equal(stub.called, false)
    assert.deepEqual(calls.forbidden, [SITE_DISABLED_MESSAGE])
    assert.deepEqual(calls.notFound, [])
  })

  test('an unknown siteId is refused 404 and never reaches done()', () => {
    const { reply, calls } = makeReplyStub()
    const stub = makeDoneStub()
    siteEnabledPreHandler({ params: { siteId: UNKNOWN_SITE_ID } } as any, reply, stub.done)
    assert.equal(stub.called, false)
    assert.deepEqual(calls.notFound, [SITE_MISSING_MESSAGE])
    assert.deepEqual(calls.forbidden, [])
  })
})

describe('siteEnabledPreHandler — wired into a real request lifecycle', () => {
  const ENABLED_SITE_ID = '11111111-1111-4111-8111-111111111111'
  const DISABLED_SITE_ID = '22222222-2222-4222-8222-222222222222'
  const UNKNOWN_SITE_ID = '99999999-9999-4999-8999-999999999999'

  const sites: Record<string, any> = {
    [ENABLED_SITE_ID]: { id: ENABLED_SITE_ID, isEnabled: true },
    [DISABLED_SITE_ID]: { id: DISABLED_SITE_ID, isEnabled: false }
  }

  let app: FastifyInstance
  let handlerCalls = 0

  before(async () => {
    const probeRoutes: FastifyPluginAsync = async (instance) => {
      // -> Added before the route, as `api/index.ts` does on its `contentApp` scope.
      instance.addHook('preHandler', siteEnabledPreHandler)
      instance.get('/sites/:siteId/probe', async () => {
        handlerCalls++
        return { ok: true }
      })
    }
    app = await buildTestApp({ routes: probeRoutes, wiki: { sites }, schemas: [] })
  })

  after(() => closeTestApp(app))

  test('a disabled site is refused before the handler runs', async () => {
    handlerCalls = 0
    const res = await app.inject({ method: 'GET', url: `/sites/${DISABLED_SITE_ID}/probe` })
    assert.equal(res.statusCode, 403)
    assert.match(res.json().message, /disabled/i)
    assert.equal(handlerCalls, 0)
  })

  test('an unknown site is refused 404 before the handler runs', async () => {
    handlerCalls = 0
    const res = await app.inject({ method: 'GET', url: `/sites/${UNKNOWN_SITE_ID}/probe` })
    assert.equal(res.statusCode, 404)
    assert.equal(res.json().message, SITE_MISSING_MESSAGE)
    assert.equal(handlerCalls, 0)
  })

  test('an enabled site reaches the handler as normal', async () => {
    handlerCalls = 0
    const res = await app.inject({ method: 'GET', url: `/sites/${ENABLED_SITE_ID}/probe` })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { ok: true })
    assert.equal(handlerCalls, 1)
  })
})

/**
 * `siteEnabledPreHandler` is registered on `contentApp` before any of these files, so every route
 * recorded here is covered structurally. What this guards is the surface shrinking silently: a
 * route losing its `:siteId`, or an expected one disappearing.
 */
describe('site-scoped route surface (covered by the shared preHandler)', () => {
  const apiDir = import.meta.dirname
  // -> `sites.ts` is registered outside the guarded `contentApp` scope, on purpose.
  const routeFiles = listApiRouteFiles(apiDir, { exclude: ['sites.ts'] })

  let siteScopedPaths: string[] = []
  let wikiHandle: { restore(): void }

  before(async () => {
    // -> Some route files read `CARDINAL.config` at registration time (`assets.ts`'s upload
    //    content-type parser), not only inside a handler.
    wikiHandle = installTestWiki()
    const found: string[] = []
    for (const file of routeFiles) {
      for (const route of await recordRoutesFrom(apiDir, file)) {
        if (route.path.includes(':siteId')) {
          found.push(route.path)
        }
      }
    }
    siteScopedPaths = [...new Set(found)]
  })

  after(() => {
    wikiHandle.restore()
  })

  test('the scan itself found a substantial number of distinct site-scoped paths', () => {
    assert.ok(
      siteScopedPaths.length >= 40,
      `expected at least 40 distinct :siteId-scoped paths, found ${siteScopedPaths.length}`
    )
  })

  const previouslyUnguarded = [
    '/sites/:siteId/pages/:pageIdOrHash',
    '/sites/:siteId/pages/:pageIdOrHash/unlock',
    '/sites/:siteId/pages/:pageId/history',
    '/sites/:siteId/pages/:pageId/history/:versionId',
    '/sites/:siteId/pages/:pageId/export',
    '/sites/:siteId/pages/:pageId/export/pdf',
    '/sites/:siteId/tree',
    '/sites/:siteId/tree/browse',
    '/sites/:siteId/tree/pages',
    '/sites/:siteId/assets',
    '/sites/:siteId/assets/:assetId',
    '/sites/:siteId/comments',
    '/sites/:siteId/navigation/:navId',
    '/sites/:siteId/live-data/resolve',
    '/sites/:siteId/glossary'
  ]

  for (const path of previouslyUnguarded) {
    test(`${path} is part of the site-scoped surface`, () => {
      assert.ok(
        siteScopedPaths.includes(path),
        `expected ${path} among the scanned :siteId-scoped routes`
      )
    })
  }

  const originallyGuarded = [
    '/sites/:siteId/pages',
    '/sites/:siteId/pages/search',
    '/sites/:siteId/pages/include'
  ]

  for (const path of originallyGuarded) {
    test(`${path} is still part of the site-scoped surface`, () => {
      assert.ok(siteScopedPaths.includes(path))
    })
  }
})

/**
 * Heavier than the describes above on purpose: the one place proving the production wiring itself,
 * not a replica of it, gets the guard's scope right.
 */
describe('the real api/index.ts, fully booted', () => {
  const DISABLED_SITE_ID = '22222222-2222-4222-8222-222222222222'
  const UNKNOWN_SITE_ID = '99999999-9999-4999-8999-999999999999'

  let app: FastifyInstance

  before(async () => {
    // -> `ajv: true` for the custom `hexcolor` format, without which building the validators throws
    //    at `app.ready()`. `schemas: []` because `apiRoutes` registers the shared set itself.
    app = await buildTestApp({
      routes: apiRoutes,
      prefix: '/_api',
      schemas: [],
      ajv: true,
      wiki: {
        config: { security: {} },
        sites: {
          [DISABLED_SITE_ID]: { id: DISABLED_SITE_ID, isEnabled: false }
        },
        models: {
          groups: {
            actorForRequest: () => ({ permissions: ['manage:sites'] }),
            checkAccess: () => true,
            checkSiteAccess: () => true
          },
          sites: {
            getSiteById: async () => ({
              id: DISABLED_SITE_ID,
              isEnabled: false,
              title: 'x',
              hostname: 'x',
              config: {}
            }),
            updateSite: async () => {},
            countEnabledSites: async () => 5
          },
          auditLog: { record: async () => {} }
        }
      }
    })
  })

  after(() => closeTestApp(app))

  test('a content route on a disabled site is refused 403', async () => {
    // -> The tree, not `/sites/:siteId/pages`: that path is POST-only, so a GET there 404s at
    //    routing, before `siteEnabledPreHandler` runs.
    const res = await app.inject({ method: 'GET', url: `/_api/sites/${DISABLED_SITE_ID}/tree` })
    assert.equal(res.statusCode, 403)
    assert.match(res.json().message, /disabled/i)
  })

  test('a content route on an unknown site is refused 404 by the same hook', async () => {
    const res = await app.inject({ method: 'GET', url: `/_api/sites/${UNKNOWN_SITE_ID}/tree` })
    assert.equal(res.statusCode, 404)
    assert.equal(res.json().message, SITE_MISSING_MESSAGE)
  })

  test('PUT /sites/:siteId — the route that re-enables a disabled site — is NOT swept in, and succeeds', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/_api/sites/${DISABLED_SITE_ID}`,
      payload: { isEnabled: true }
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { ok: true, message: 'Site updated successfully.' })
  })
})

describe('the real api/index.ts, not yet ready', () => {
  let app: FastifyInstance

  before(async () => {
    app = await buildTestApp({
      routes: apiRoutes,
      prefix: '/_api',
      schemas: [],
      ajv: true,
      wiki: {
        server: { isReady: () => false }
      }
    })
  })

  after(() => closeTestApp(app))

  test('a sites.ts route (registered directly on the plugin) answers 503 with Retry-After', async () => {
    const res = await app.inject({ method: 'GET', url: '/_api/sites' })
    assert.equal(res.statusCode, 503)
    assert.equal(res.headers['retry-after'], '1')
    assert.deepEqual(res.json(), {
      ok: false,
      error: 'ServiceUnavailableError',
      statusCode: 503,
      message: 'The server is still starting up. Try again in a moment.'
    })
  })

  test('a contentApp route (e.g. the site tree) answers 503 with Retry-After too', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/_api/sites/11111111-1111-4111-8111-111111111111/tree'
    })
    assert.equal(res.statusCode, 503)
    assert.equal(res.headers['retry-after'], '1')
  })
})
