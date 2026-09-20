import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import readRoutes from './read.ts'
import { siteEnabledPreHandler } from '../../helpers/siteResolution.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'
import { ensureTemporal } from '../../test/temporal.ts'

const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'
const SITE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const UNKNOWN_SITE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const NO_FILTERS = {
  path: [],
  excludePath: [],
  excludeLocales: [],
  tags: [],
  tagsMatch: 'all',
  excludeTags: [],
  editor: [],
  excludeEditor: [],
  publishState: [],
  excludePublishState: [],
  creatorId: [],
  excludeCreatorId: [],
  authorId: [],
  excludeAuthorId: []
}

let searchCalls: Array<{
  query: string
  actor: { id: string } | undefined
  siteId: string
  locales: string[]
  options: {
    limit: number
    offset: number
    path?: string[]
    excludePath?: string[]
    tags?: string[]
    tagsMatch?: string
    excludeTags?: string[]
    excludeLocales?: string[]
    editor?: string[]
    excludeEditor?: string[]
    publishState?: string[]
    excludePublishState?: string[]
    creatorId?: string[]
    excludeCreatorId?: string[]
    authorId?: string[]
    excludeAuthorId?: string[]
  }
}>
let allPages: Array<{ id: string; path: string; visibleTo: string | null }>
let capabilityEnabled: boolean
let siteSemanticEnabled: boolean
/** When set, stands in for the site's whole `search` config, to present a mis-nested shape. */
let siteSearchConfigOverride: Record<string, any> | null

async function search(
  query: string,
  actor: { id: string } | undefined,
  siteId: string,
  locales: string[],
  options: {
    limit: number
    offset: number
    path?: string[]
    excludePath?: string[]
    tags?: string[]
    tagsMatch?: string
    excludeTags?: string[]
    excludeLocales?: string[]
    editor?: string[]
    excludeEditor?: string[]
    publishState?: string[]
    excludePublishState?: string[]
    creatorId?: string[]
    excludeCreatorId?: string[]
    authorId?: string[]
    excludeAuthorId?: string[]
  }
) {
  searchCalls.push({ query, actor, siteId, locales, options })
  // -> Mimics the model's own visibility filter, so a filtered response proves the route passed the
  //    actor through
  const visible = allPages.filter((p) => p.visibleTo === null || p.visibleTo === actor?.id)
  return {
    results: visible.map((p) => ({
      pageId: p.id,
      path: p.path,
      locale: 'en',
      title: p.path,
      description: null,
      icon: null,
      chunkText: `chunk of ${p.path}`,
      chunkIndex: 0,
      distance: 0.1,
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
    // -> Getters, which `createWikiStub`'s deep merge preserves: the module-level flags steer these
    //    per test without rebuilding the app
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
  // -> The unknown-site 404 lives in `siteEnabledPreHandler`, which `api/index.ts` registers for
  //    the real tree -- a plugin-only test app has to add it itself
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

// -> The setting is saved at `search.config.semanticEnabled`; one level shallower must not satisfy
//    the gate
test('503s when the setting is present but at the old, un-nested `search.semanticEnabled` shape', async () => {
  siteSearchConfigOverride = { semanticEnabled: true }
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/search/semantic?query=hello`
  })
  assert.equal(res.statusCode, 503)
  assert.equal(searchCalls.length, 0)
})

test('calls the model with query/locales/limit/offset and returns its results when both flags are on', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/search/semantic?query=hello&locales=fr&limit=10&offset=5`
  })
  assert.equal(res.statusCode, 200)
  assert.equal(searchCalls.length, 1)
  const call = searchCalls[0]!
  assert.equal(call.query, 'hello')
  assert.equal(call.siteId, SITE_ID)
  assert.deepEqual(call.locales, ['fr'])
  assert.deepEqual(call.options, {
    ...NO_FILTERS,
    limit: 10,
    offset: 5
  })

  const body = res.json()
  assert.deepEqual(
    body.results.map((r: { path: string; hop: number }) => [r.path, r.hop]),
    [['docs/one', 1]]
  )
  assert.equal(body.totalHits, 1)

  // -> The response schema must carry `SemanticSearchResult`'s chunk fields and none of the
  //    full-text `SearchResult` ones
  const [result] = body.results
  assert.equal(result.pageId, 'page-1')
  assert.equal(result.chunkText, 'chunk of docs/one')
  assert.equal(result.chunkIndex, 0)
  assert.equal(result.distance, 0.1)
  assert.equal('id' in result, false)
  assert.equal('tags' in result, false)
  assert.equal('updatedAt' in result, false)
  assert.equal('relevancy' in result, false)
  assert.equal('highlight' in result, false)
})

test('defaults locales, limit and offset when omitted', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/search/semantic?query=hello`
  })
  assert.equal(res.statusCode, 200)
  assert.equal(searchCalls.length, 1)
  const call = searchCalls[0]!
  assert.deepEqual(call.locales, ['en'])
  assert.deepEqual(call.options, {
    ...NO_FILTERS,
    limit: 25,
    offset: 0
  })
})

test('forwards path/tags/editor/publishState to the model (OpenProject #3328)', async () => {
  const res = await app.inject({
    method: 'GET',
    url:
      `/sites/${SITE_ID}/pages/search/semantic?query=hello` +
      '&path=docs%2Fguides&tags=foo,bar&editor=markdown&publishState=published'
  })
  assert.equal(res.statusCode, 200)
  assert.equal(searchCalls.length, 1)
  const call = searchCalls[0]!
  assert.deepEqual(call.options, {
    ...NO_FILTERS,
    limit: 25,
    offset: 0,
    path: ['docs/guides'],
    tags: ['foo', 'bar'],
    editor: ['markdown'],
    publishState: ['published']
  })
})

test('forwards repeated include and every exclude list to the model', async () => {
  const res = await app.inject({
    method: 'GET',
    url:
      `/sites/${SITE_ID}/pages/search/semantic?query=hello` +
      '&path=docs&path=guides&excludePath=docs%2Fprivate&excludeLocales=fr,de' +
      '&excludeTags=old&excludeEditor=code&editor=markdown&editor=wysiwyg' +
      '&excludePublishState=draft&excludePublishState=scheduled'
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(searchCalls[0]!.options, {
    limit: 25,
    offset: 0,
    path: ['docs', 'guides'],
    excludePath: ['docs/private'],
    excludeLocales: ['fr', 'de'],
    tags: [],
    tagsMatch: 'all',
    excludeTags: ['old'],
    editor: ['markdown', 'wysiwyg'],
    excludeEditor: ['code'],
    publishState: [],
    excludePublishState: ['draft', 'scheduled'],
    creatorId: [],
    excludeCreatorId: [],
    authorId: [],
    excludeAuthorId: []
  })
})

test('forwards tagsMatch=any to the model', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/search/semantic?query=hello&tags=foo,bar&tagsMatch=any`
  })
  assert.equal(res.statusCode, 200)
  assert.equal(searchCalls[0]!.options.tagsMatch, 'any')
  assert.deepEqual(searchCalls[0]!.options.tags, ['foo', 'bar'])
})

test('rejects a tagsMatch other than all or any', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/search/semantic?query=hello&tags=foo&tagsMatch=some`
  })
  assert.equal(res.statusCode, 400)
  assert.equal(searchCalls.length, 0)
})

test('forwards creator and author lists to the model', async () => {
  const res = await app.inject({
    method: 'GET',
    url:
      `/sites/${SITE_ID}/pages/search/semantic?query=hello` +
      `&creatorId=${U1}&excludeCreatorId=${U2}&authorId=${U1}&authorId=${U2}&excludeAuthorId=${U2}`
  })
  assert.equal(res.statusCode, 200)
  const { options } = searchCalls[0]!
  assert.deepEqual(options.creatorId, [U1])
  assert.deepEqual(options.excludeCreatorId, [U2])
  assert.deepEqual(options.authorId, [U1, U2])
  assert.deepEqual(options.excludeAuthorId, [U2])
})

test('rejects a creatorId that is not a uuid on the semantic route', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/search/semantic?query=hello&creatorId=nope`
  })
  assert.equal(res.statusCode, 400)
})

test('rejects a publishState outside the known states in either list', async () => {
  const include = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/search/semantic?query=hello&publishState=bogus`
  })
  assert.equal(include.statusCode, 400)
  const exclude = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/search/semantic?query=hello&excludePublishState=bogus`
  })
  assert.equal(exclude.statusCode, 400)
})

test('accepts several comma-separated locales', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/pages/search/semantic?query=hello&locales=en,fr`
  })
  assert.equal(res.statusCode, 200)
  const call = searchCalls[0]!
  assert.deepEqual(call.locales, ['en', 'fr'])
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
