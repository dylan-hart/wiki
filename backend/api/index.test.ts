import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import apiRoutes from './index.ts'
import {
  siteEnabledPreHandler,
  SITE_DISABLED_MESSAGE,
  SITE_MISSING_MESSAGE
} from '../helpers/siteResolution.ts'

/**
 * OpenProject task 1593: `guardSiteEnabled` moved from nine hand-applied call sites (one per route
 * handler) to `siteEnabledPreHandler`, one `preHandler` registered on the guarded `contentApp`
 * encapsulation `index.ts` builds before any content route file is registered into it. Four things
 * are worth locking down, since none of them can regress silently the way a hand-applied call site's
 * *absence* used to:
 *
 * 1. The preHandler function itself answers the four cases correctly (below, direct unit tests) —
 *    including the unknown-site `404` it also owns now (spec D1): the 36 hand-written site-existence
 *    preambles that used to answer that per route, in two different spellings, are gone.
 * 2. Wired into a real Fastify request lifecycle, it actually blocks a disabled site's request (and an
 *    unknown site's) before a route handler ever runs, and lets everything else through (below, an
 *    `app.inject` round trip).
 * 3. The site-scoped route surface it is meant to cover is broad — GET PAGE, UNLOCK, history,
 *    exports, the tree, asset upload/rename/delete, comments, navigation, live-data and glossary —
 *    not just the three routes (LIST/SEARCH/INCLUDE) OpenProject task 699 originally guarded by hand.
 *    (below, a structural scan in the shape of `routeTags.test.ts`.)
 * 4. `sites.ts`'s own site-ADMINISTRATION routes — `PUT /sites/:siteId`, which is how `isEnabled` is
 *    flipped back to `true` in the first place — are NOT swept in by the same global-sounding
 *    preHandler, which would otherwise make a disabled site permanently un-re-enableable through the
 *    API. Proven below against the real, fully-booted `index.ts`, not a synthetic route, since this is
 *    exactly the kind of thing a too-broad refactor of "one preHandler for every `:siteId` route"
 *    could silently reintroduce.
 *
 * What is deliberately NOT folded in here: `bootstrap.ts`'s own `guardSiteEnabled` call. Its one route
 * resolves a site by hostname (`req.query.hostname ?? req.hostname`), never by a `:siteId` path
 * param, so this preHandler — which only ever fires on `req.params.siteId` — cannot subsume it. See
 * `bootstrap.ts`'s own doc comment on that call site.
 */

/** A stand-in for `FastifyReply` recording the two methods `siteEnabledPreHandler` may call. */
function fakeReply() {
  const calls: { forbidden: string[]; notFound: string[] } = { forbidden: [], notFound: [] }
  const reply: any = {
    forbidden(message: string) {
      calls.forbidden.push(message)
      return reply
    },
    notFound(message: string) {
      calls.notFound.push(message)
      return reply
    }
  }
  return { reply, calls }
}

/** Records whether `done()` was invoked, the way a real Fastify `preHandler` callback would call it. */
function fakeDone() {
  let called = false
  return { done: () => (called = true), wasCalled: () => called }
}

describe('siteEnabledPreHandler', () => {
  const ENABLED_SITE_ID = '11111111-1111-4111-8111-111111111111'
  const DISABLED_SITE_ID = '22222222-2222-4222-8222-222222222222'
  const UNKNOWN_SITE_ID = '99999999-9999-4999-8999-999999999999'

  const sites: Record<string, any> = {
    [ENABLED_SITE_ID]: { id: ENABLED_SITE_ID, isEnabled: true },
    [DISABLED_SITE_ID]: { id: DISABLED_SITE_ID, isEnabled: false }
  }

  before(() => {
    ;(globalThis as any).WIKI = { sites }
  })

  after(() => {
    delete (globalThis as any).WIKI
  })

  test('a route with no siteId param passes through untouched', () => {
    const { reply, calls } = fakeReply()
    const { done, wasCalled } = fakeDone()
    siteEnabledPreHandler({ params: {} } as any, reply, done)
    assert.equal(wasCalled(), true)
    assert.deepEqual(calls.forbidden, [])
    assert.deepEqual(calls.notFound, [])
  })

  test('an enabled site passes through', () => {
    const { reply, calls } = fakeReply()
    const { done, wasCalled } = fakeDone()
    siteEnabledPreHandler({ params: { siteId: ENABLED_SITE_ID } } as any, reply, done)
    assert.equal(wasCalled(), true)
    assert.deepEqual(calls.forbidden, [])
    assert.deepEqual(calls.notFound, [])
  })

  test('a disabled site is refused 403 and never reaches done()', () => {
    const { reply, calls } = fakeReply()
    const { done, wasCalled } = fakeDone()
    siteEnabledPreHandler({ params: { siteId: DISABLED_SITE_ID } } as any, reply, done)
    assert.equal(wasCalled(), false)
    assert.deepEqual(calls.forbidden, [SITE_DISABLED_MESSAGE])
    assert.deepEqual(calls.notFound, [])
  })

  test('an unknown siteId is refused 404 and never reaches done()', () => {
    const { reply, calls } = fakeReply()
    const { done, wasCalled } = fakeDone()
    siteEnabledPreHandler({ params: { siteId: UNKNOWN_SITE_ID } } as any, reply, done)
    assert.equal(wasCalled(), false)
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
    ;(globalThis as any).WIKI = { sites }

    app = Fastify()
    await app.register(fastifySensible)
    app.setErrorHandler((error: any, req, reply) => {
      reply.code(error.statusCode ?? 500).send({
        ok: false,
        error: error.name,
        statusCode: error.statusCode ?? 500,
        message: error.message
      })
    })
    // -> Registered before the route, mirroring exactly how `index.ts` registers it on `app` before
    //    any `app.register(...)` call for a route file.
    app.addHook('preHandler', siteEnabledPreHandler)
    app.get('/sites/:siteId/probe', async () => {
      handlerCalls++
      return { ok: true }
    })
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

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
 * Structural scan, in the shape of `routeTags.test.ts`: walks every CONTENT route file under `api/`
 * (everything `index.ts` registers inside its guarded `contentApp` encapsulation — see that file's own
 * comment) and replays its registration against a recording stub (not a real Fastify instance — see
 * `routeTags.test.ts`'s own header comment for why), collecting every route whose registered path
 * contains `:siteId`. Since `siteEnabledPreHandler` is registered once on `contentApp` before any
 * of these files is registered into it, EVERY route recorded here is covered by it structurally —
 * there is no per-route opt-in left to individually verify. What this guards against is the surface
 * shrinking silently: if a route that should carry a `:siteId` ever stops doing so (or a route this
 * list expects disappears), that is exactly the kind of drift a hand-applied call site could hide and
 * a hard-coded assertion list here catches.
 *
 * `sites.ts` is deliberately excluded from this scan, not merely absent from the assertion list below:
 * its own `:siteId` routes (`PUT`/`DELETE /sites/:siteId`, ...) are registered OUTSIDE `contentApp`,
 * on purpose — see `index.ts`'s comment there, and the "fully booted" describe block above, which
 * proves that exemption directly against the real app rather than by scanning file text.
 */
describe('site-scoped route surface (covered by the shared preHandler)', () => {
  const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const
  type HttpMethod = (typeof HTTP_METHODS)[number]

  interface RecordedRoute {
    method: HttpMethod
    path: string
  }

  function createRecordingApp(): { app: any; routes: RecordedRoute[] } {
    const routes: RecordedRoute[] = []
    const app: any = {
      addContentTypeParser: () => {},
      addHook: () => {},
      addSchema: () => {},
      register: () => app
    }
    for (const method of HTTP_METHODS) {
      app[method] = (routePath: string) => {
        routes.push({ method, path: routePath })
        return app
      }
    }
    return { app, routes }
  }

  const apiDir = import.meta.dirname
  const routeFiles = readdirSync(apiDir)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    // -> Not part of the guarded `contentApp` surface — see this describe block's own doc comment.
    .filter((file) => file !== 'index.ts' && file !== 'sites.ts')
    .sort()

  let siteScopedPaths: string[] = []

  before(async () => {
    // -> A handful of route files touch `WIKI.config` at registration time (`assets.ts`'s upload
    //    content-type parser), not just inside a handler — see `routeTags.test.ts`'s own header
    //    comment for the same stub. Set fresh here rather than at module scope: this describe runs
    //    after two earlier ones that each delete `globalThis.WIKI` in their own `after()`.
    ;(globalThis as any).WIKI = { config: {} }
    const found: string[] = []
    for (const file of routeFiles) {
      const { app, routes } = createRecordingApp()
      const mod = await import(`./${file}`)
      await mod.default(app)
      for (const route of routes) {
        if (route.path.includes(':siteId')) {
          found.push(route.path)
        }
      }
    }
    siteScopedPaths = [...new Set(found)]
  })

  after(() => {
    delete (globalThis as any).WIKI
  })

  test('the scan itself found a substantial number of distinct site-scoped paths', () => {
    // Sanity check on the scan, matching `routeTags.test.ts`'s own: a filter typo that silently
    // matched nothing would make every assertion below vacuously pass.
    assert.ok(
      siteScopedPaths.length >= 40,
      `expected at least 40 distinct :siteId-scoped paths, found ${siteScopedPaths.length}`
    )
  })

  /**
   * The gap the audit named (`docs/audit-2026-08-24/correctness-api-routes.md` §1): every one of
   * these used to serve a disabled site's full content, because `guardSiteEnabled` was never
   * hand-applied to it. Now covered structurally, since the preHandler applies to the whole `/_api`
   * tree regardless of which file a route is declared in.
   */
  const previouslyUnguarded = [
    '/sites/:siteId/pages/:pageIdOrHash', // GET PAGE
    '/sites/:siteId/pages/:pageIdOrHash/unlock', // UNLOCK
    '/sites/:siteId/pages/:pageId/history',
    '/sites/:siteId/pages/:pageId/history/:versionId',
    '/sites/:siteId/pages/:pageId/export',
    '/sites/:siteId/pages/:pageId/export/pdf',
    '/sites/:siteId/tree',
    '/sites/:siteId/tree/browse',
    '/sites/:siteId/tree/pages',
    '/sites/:siteId/assets', // upload
    '/sites/:siteId/assets/:assetId', // rename (PATCH) / delete (DELETE), also the already-guarded GET
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

  // -> The three routes OpenProject task 699 originally guarded by hand, kept as a floor rather than
  //    a ceiling: the point of task 1593 is that the surface is no longer limited to these.
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
 * The real, fully-booted `api/index.ts` — every schema and every route file, exactly as `index.ts`
 * (the top-level entry) registers it under `/_api`. Heavier than the other describe blocks above on
 * purpose: this is the one place proving the actual production wiring, not a re-implementation of it,
 * gets the guard's *scope* right — see this file's own header comment, point 4.
 */
describe('the real api/index.ts, fully booted', () => {
  const DISABLED_SITE_ID = '22222222-2222-4222-8222-222222222222'
  const UNKNOWN_SITE_ID = '99999999-9999-4999-8999-999999999999'

  let app: FastifyInstance

  before(async () => {
    ;(globalThis as any).WIKI = {
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
      },
      logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }
    }

    app = Fastify({
      ajv: {
        plugins: [[ajvFormats.default, {}] as any],
        // -> `index.ts` (the top-level entry) registers this same custom format on `onCreate` —
        //    without it, building the validator for `theme.colorPrimary` (and friends) throws at
        //    `app.ready()`, before any test here ever runs.
        onCreate: (ajv: any) => {
          ajv.addFormat('hexcolor', (data: unknown) => {
            return (
              typeof data === 'string' &&
              /^#(?:[a-fA-F0-9]{3,4}|[a-fA-F0-9]{6}|[a-fA-F0-9]{8})$/.test(data)
            )
          })
        }
      }
    })
    await app.register(fastifySensible)
    app.setErrorHandler((error: any, req, reply) => {
      reply.code(error.statusCode ?? 500).send({
        ok: false,
        error: error.name,
        statusCode: error.statusCode ?? 500,
        message: error.message
      })
    })
    await app.register(apiRoutes, { prefix: '/_api' })
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  test('a content route on a disabled site is refused 403', async () => {
    // -> GET PAGES tree (`/sites/:siteId/tree`), not `/sites/:siteId/pages` -- that exact path is
    //    POST-only (CREATE PAGE), so a GET there 404s at the Fastify routing layer before
    //    `siteEnabledPreHandler` ever runs, regardless of the site's `isEnabled` state.
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
