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
      // -> Registered before the route, mirroring exactly how `api/index.ts` registers it on its
      //    `contentApp` scope before any `register(...)` call for a route file.
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
  const apiDir = import.meta.dirname
  // -> `sites.ts` is not part of the guarded `contentApp` surface — see this describe block's own
  //    doc comment.
  const routeFiles = listApiRouteFiles(apiDir, { exclude: ['sites.ts'] })

  let siteScopedPaths: string[] = []
  let wikiHandle: { restore(): void }

  before(async () => {
    // -> A handful of route files touch `WIKI.config` at registration time (`assets.ts`'s upload
    //    content-type parser), not just inside a handler. Installed fresh here rather than at module
    //    scope: this describe runs after two earlier ones that each restore `globalThis.WIKI` in
    //    their own `after()`.
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
    // -> `ajv: true` gives this instance `index.ts`'s own custom `hexcolor` format — without it,
    //    building the validator for `theme.colorPrimary` (and friends) throws at `app.ready()`,
    //    before any test here ever runs. `schemas: []` because `apiRoutes` registers the shared set
    //    itself, exactly as the real boot does.
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
