import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import readRoutes from './read.ts'
import { siteEnabledPreHandler } from '../../helpers/siteResolution.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'
import { ensureTemporal } from '../../test/temporal.ts'

/**
 * Route-wiring tests for `GET /sites/:siteId/pages/search/semantic` (Epic #3050, Task #3102).
 *
 * `WIKI.models.semanticSearch.search()` is stubbed outright -- the multi-hop retrieval/ranking logic
 * itself belongs to Feature #3092's own tests (Tasks #3099/#3100/#3101), which do not exist in this
 * worktree yet (see this work package's `[implementation plan]` comment). This suite covers only what
 * `read.ts` itself does: the unknown-site 404, the `features.semanticSearch` 503 gate (both halves —
 * the boot-time capability flag AND the site's own admin setting, so neither alone can turn the route
 * on), that query/locale/limit/offset reach `search()` as documented, and that the route forwards the
 * caller's actor through to `search()` rather than doing its own filtering (or none at all).
 */

const SITE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const UNKNOWN_SITE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

let searchCalls: Array<{
  query: string
  actor: { id: string } | undefined
  siteId: string
  locale: string
  options: { limit: number; offset: number }
}>
/** Every "page" the stub model could return, each visible only to the actor named in `visibleTo`. */
let allPages: Array<{ id: string; path: string; visibleTo: string | null }>
let capabilityEnabled: boolean
let siteSemanticEnabled: boolean
/**
 * OpenProject #3137: when set, replaces the `sites` getter's usual `search.config.semanticEnabled`
 * shape with this literal `search` value instead — used to prove the route reads the same nesting
 * `api/search.ts`'s PATCH handler actually saves to, not the shallower shape a since-fixed bug once
 * read from.
 */
let siteSearchConfigOverride: Record<string, any> | null

async function search(
  query: string,
  actor: { id: string } | undefined,
  siteId: string,
  locale: string,
  options: { limit: number; offset: number }
) {
  searchCalls.push({ query, actor, siteId, locale, options })
  // -> Mimics what the real `models/semanticSearch.ts#search()` does with `filterVisible`: a page
  //    only appears for the actor it names, or for everyone when it names none. Proves the route
  //    passes the actor through rather than filtering itself (or not filtering at all).
  const visible = allPages.filter((p) => p.visibleTo === null || p.visibleTo === actor?.id)
  return {
    results: visible.map((p) => ({
      id: p.id,
      path: p.path,
      locale: 'en',
      title: p.path,
      description: null,
      icon: null,
      tags: [],
      updatedAt: '2026-09-01T00:00:00.000Z',
      relevancy: 1,
      highlight: null,
      hop: 1 as const
    })),
    totalHits: visible.length,
    totalHitsApproximate: false,
    suggestion: null
  }
}

let app: FastifyInstance

before(async () => {
  await ensureTemporal()
  const wiki = {
    // -> Getters, not plain values: `createWikiStub`'s deep merge copies property DESCRIPTORS, so
    //    these are re-evaluated on every access and can be steered per test via the module-level
    //    flags below, without rebuilding the app.
    get capabilities() {
      return { semanticSearch: capabilityEnabled }
    },
    get sites() {
      return {
        [SITE_ID]: {
          config: {
            search: siteSearchConfigOverride ?? { config: { semanticEnabled: siteSemanticEnabled } }
          }
        }
      }
    },
    models: {
      semanticSearch: { search },
      groups: {
        actorForRequest: (req: { headers: Record<string, string | string[] | undefined> }) => {
          const header = req.headers['x-test-actor']
          return typeof header === 'string' ? { id: header } : undefined
        }
      }
    }
  }
  // -> The unknown-site 404 lives in `siteEnabledPreHandler`, registered once for the real `/_api`
  //    tree in `api/index.ts` -- a plugin-only test app has to add it itself to see that behavior,
  //    same pattern `api/search.test.ts` uses.
  const guardedRoutes: FastifyPluginAsync = async (instance) => {
    instance.addHook('preHandler', siteEnabledPreHandler)
    await instance.register(readRoutes)
  }
  app = await buildTestApp({ routes: guardedRoutes, ajv: true, wiki, session: 'header' })
})

after(() => closeTestApp(app))

beforeEach(() => {
  searchCalls = []
  allPages = [
    { id: 'page-1', path: 'docs/one', visibleTo: null },
    { id: 'page-2', path: 'docs/secret', visibleTo: 'user-a' }
  ]
  capabilityEnabled = true
  siteSemanticEnabled = true
  siteSearchConfigOverride = null
})

test('404s for a site that does not exist', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${UNKNOWN_SITE_ID}/pages/search/semantic?query=hello`
  })
  assert.equal(res.statusCode, 404)
})

test('503s when the boot-time capability flag is off, even with the site setting on', async () => {
  capabilityEnabled = false
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/search/semantic?query=hello`
  })
  assert.equal(res.statusCode, 503)
  assert.equal(searchCalls.length, 0)
})

test("503s when the site's own admin setting is off, even with the capability flag on", async () => {
  siteSemanticEnabled = false
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/search/semantic?query=hello`
  })
  assert.equal(res.statusCode, 503)
  assert.equal(searchCalls.length, 0)
})

/**
 * OpenProject #3137: `semanticSearchEnabledFor` used to read `search.semanticEnabled` -- one level
 * shallower than where `api/search.ts`'s PATCH handler actually saves it
 * (`search.config.semanticEnabled`) -- so the route always 503'd regardless of the stored setting.
 * Reproduces the exact stale shape to prove it no longer satisfies the gate.
 */
test('503s when the setting is present but at the old, un-nested `search.semanticEnabled` shape', async () => {
  siteSearchConfigOverride = { semanticEnabled: true }
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/search/semantic?query=hello`
  })
  assert.equal(res.statusCode, 503)
  assert.equal(searchCalls.length, 0)
})

test('calls the model with query/locale/limit/offset and returns its results when both flags are on', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/search/semantic?query=hello&locale=fr&limit=10&offset=5`
  })
  assert.equal(res.statusCode, 200)
  assert.equal(searchCalls.length, 1)
  const call = searchCalls[0]!
  assert.equal(call.query, 'hello')
  assert.equal(call.siteId, SITE_ID)
  assert.equal(call.locale, 'fr')
  assert.deepEqual(call.options, { limit: 10, offset: 5 })

  const body = res.json()
  assert.deepEqual(
    body.results.map((r: { path: string; hop: number }) => [r.path, r.hop]),
    [['docs/one', 1]]
  )
  assert.equal(body.totalHits, 1)
})

test('defaults locale, limit and offset when omitted', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/search/semantic?query=hello`
  })
  assert.equal(res.statusCode, 200)
  assert.equal(searchCalls.length, 1)
  const call = searchCalls[0]!
  assert.equal(call.locale, 'en')
  assert.deepEqual(call.options, { limit: 25, offset: 0 })
})

test('a page visible to everyone appears for an anonymous caller, a page scoped to another actor does not', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/search/semantic?query=hello`
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.deepEqual(
    body.results.map((r: { path: string }) => r.path),
    ['docs/one']
  )
})

test('a page the caller cannot read never appears in the response', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/search/semantic?query=hello`,
    headers: { 'x-test-actor': 'user-b' }
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.deepEqual(
    body.results.map((r: { path: string }) => r.path),
    ['docs/one']
  )
})

test('a page scoped to the requesting actor is included', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/search/semantic?query=hello`,
    headers: { 'x-test-actor': 'user-a' }
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.deepEqual(body.results.map((r: { path: string }) => r.path).sort(), [
    'docs/one',
    'docs/secret'
  ])
})

test('rejects a request with no query', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/search/semantic`
  })
  assert.equal(res.statusCode, 400)
  assert.equal(searchCalls.length, 0)
})
