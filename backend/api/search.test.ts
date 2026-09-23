import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { siteEnabledPreHandler } from '../helpers/siteResolution.ts'
import searchRoutes from './search.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

const SITE_ID = '11111111-1111-1111-1111-111111111111'
const sites: Record<string, any> = {
  [SITE_ID]: { id: SITE_ID, config: {} }
}

function makeDbEngine() {
  return {
    key: 'db',
    title: 'Database',
    description: 'PostgreSQL full-text search.',
    vendor: 'Cardinal.js',
    website: 'https://js.wiki',
    props: { termHighlighting: { type: 'boolean', title: 'Term Highlighting', default: false } },
    hasImplementation: false,
    isSelected: true,
    config: { termHighlighting: false }
  }
}

const dictOverrides = { en: 'english' }
const availableDictionaries = ['english', 'simple']

const storedEngineConfig = { termHighlighting: false }

let app: FastifyInstance
let refreshCalls: number
let selectCalls: any[]
let validateCalls: any[]
let validateResult: string | null
let updateSiteCalls: any[]
let semanticEnabled: boolean
let semanticMinMatch: number

before(async () => {
  refreshCalls = 0
  selectCalls = []
  validateCalls = []
  validateResult = null
  updateSiteCalls = []
  semanticEnabled = false
  semanticMinMatch = 0

  const wiki = {
    sites,
    models: {
      search: {
        // -> A fresh object per call: `withDbSearchExtras` mutates the `db` entry it's handed, and
        //    a shared object would leak that into the next test's assertions
        getSiteEngines: async (siteId: string) => (sites[siteId] ? [makeDbEngine()] : []),
        getDefinition: (key: string) => (key === 'db' ? makeDbEngine() : null),
        getEngineConfig: (_siteId: string, _key: string) => storedEngineConfig,
        validateEngineConfig: (key: string, incoming: any, existing: any) => {
          validateCalls.push([key, incoming, existing])
          return validateResult
        },
        selectEngine: async (siteId: string, key: string, incoming: any) => {
          selectCalls.push([siteId, key, incoming])
          return true
        },
        refreshFromDisk: async () => {
          refreshCalls++
        },
        getConfig: (_siteId: string) => ({ dictOverrides, semanticEnabled, semanticMinMatch }),
        getAvailableDictionaries: async () => availableDictionaries
      },
      sites: {
        updateSite: async (siteId: string, patch: any) => {
          updateSiteCalls.push([siteId, patch])
          return true
        }
      }
    }
  }

  // -> The unknown-site 404 lives in this hook, not in the route handlers, so a plugin-only app has
  //    to register it to answer that case the way the real app does.
  const guardedRoutes: FastifyPluginAsync = async (instance) => {
    instance.addHook('preHandler', siteEnabledPreHandler)
    await instance.register(searchRoutes)
  }

  app = await buildTestApp({ routes: guardedRoutes, ajv: true, wiki })
})

after(() => closeTestApp(app))

test('GET .../search/engines 404s for a site that does not exist', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/sites/22222222-2222-2222-2222-222222222222/search/engines'
  })
  assert.equal(res.statusCode, 404)
})

test('GET .../search/engines returns the model’s engine list for an existing site', async () => {
  const res = await app.inject({ method: 'GET', url: `/sites/${SITE_ID}/search/engines` })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), [{ ...makeDbEngine(), dictOverrides, availableDictionaries }])
})

test('GET .../search/engines attaches dictOverrides/availableDictionaries onto the db entry only', async () => {
  const res = await app.inject({ method: 'GET', url: `/sites/${SITE_ID}/search/engines` })
  const [db] = res.json()
  assert.deepEqual(db.dictOverrides, dictOverrides)
  assert.deepEqual(db.availableDictionaries, availableDictionaries)
})

test('PUT .../search/engines/:key 404s for a site that does not exist', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: '/sites/22222222-2222-2222-2222-222222222222/search/engines/db',
    payload: { config: {} }
  })
  assert.equal(res.statusCode, 404)
})

test('PUT .../search/engines/:key 404s for an engine key nothing declares', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/sites/${SITE_ID}/search/engines/nonexistent`,
    payload: { config: {} }
  })
  assert.equal(res.statusCode, 404)
})

test('PUT .../search/engines/:key 400s when the model rejects the config', async () => {
  validateResult = '"bogus" is not a config value Database accepts.'
  const res = await app.inject({
    method: 'PUT',
    url: `/sites/${SITE_ID}/search/engines/db`,
    payload: { config: { bogus: true } }
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().message, /bogus/)
  validateResult = null
})

test('PUT .../search/engines/:key selects the engine and echoes success on a valid config', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/sites/${SITE_ID}/search/engines/db`,
    payload: { config: { termHighlighting: true } }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)
  assert.deepEqual(selectCalls, [[SITE_ID, 'db', { termHighlighting: true }]])
})

test('PUT .../search/engines/:key validates against the site’s stored config for that engine, task #556', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/sites/${SITE_ID}/search/engines/db`,
    payload: { config: { termHighlighting: true } }
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(validateCalls.at(-1), ['db', { termHighlighting: true }, storedEngineConfig])
})

test('POST .../search/refresh 404s for a site that does not exist', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/sites/22222222-2222-2222-2222-222222222222/search/refresh'
  })
  assert.equal(res.statusCode, 404)
})

test('POST .../search/refresh re-reads definitions from disk and returns the refreshed list', async () => {
  const res = await app.inject({ method: 'POST', url: `/sites/${SITE_ID}/search/refresh` })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), [{ ...makeDbEngine(), dictOverrides, availableDictionaries }])
  assert.equal(refreshCalls, 1)
})

test('PATCH .../search rejects a malformed locale code with a coded error', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: `/sites/${SITE_ID}/search`,
    payload: { dictOverrides: { 'not a locale': 'english' } }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().message, 'ERR_INVALID_LOCALE_CODE')
})

test('PATCH .../search rejects a dictionary the database does not have with a coded error', async () => {
  const res = await app.inject({
    method: 'PATCH',
    url: `/sites/${SITE_ID}/search`,
    payload: { dictOverrides: { en: 'not-a-real-dictionary' } }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().message, 'ERR_INVALID_SEARCH_DICTIONARY')
})

/**
 * `CARDINAL.capabilities.semanticSearch` is set per test below by mutating the installed global,
 * since `buildTestApp` installs the `CARDINAL` stub once for the whole file.
 */
test('PATCH .../search rejects semanticEnabled: true when the capability is unavailable', async () => {
  ;(globalThis as any).CARDINAL.capabilities = { semanticSearch: false }
  const res = await app.inject({
    method: 'PATCH',
    url: `/sites/${SITE_ID}/search`,
    payload: { semanticEnabled: true }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().message, 'ERR_SEMANTIC_SEARCH_UNAVAILABLE')
  assert.deepEqual(updateSiteCalls, [])
})

test('PATCH .../search accepts semanticEnabled: true when the capability is available', async () => {
  ;(globalThis as any).CARDINAL.capabilities = { semanticSearch: true }
  const res = await app.inject({
    method: 'PATCH',
    url: `/sites/${SITE_ID}/search`,
    payload: { semanticEnabled: true }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)
  assert.deepEqual(updateSiteCalls.at(-1), [
    SITE_ID,
    { config: { search: { config: { semanticEnabled: true } } } }
  ])
})

test('PATCH .../search always accepts semanticEnabled: false, capability or no capability', async () => {
  ;(globalThis as any).CARDINAL.capabilities = { semanticSearch: false }
  const res = await app.inject({
    method: 'PATCH',
    url: `/sites/${SITE_ID}/search`,
    payload: { semanticEnabled: false }
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(updateSiteCalls.at(-1), [
    SITE_ID,
    { config: { search: { config: { semanticEnabled: false } } } }
  ])
})

test('PATCH .../search 400s when none of dictOverrides, semanticEnabled or semanticMinMatch is provided', async () => {
  const res = await app.inject({ method: 'PATCH', url: `/sites/${SITE_ID}/search`, payload: {} })
  assert.equal(res.statusCode, 400)
})

test('PATCH .../search stores semanticMinMatch on its own', async () => {
  ;(globalThis as any).CARDINAL.capabilities = { semanticSearch: false }
  const res = await app.inject({
    method: 'PATCH',
    url: `/sites/${SITE_ID}/search`,
    payload: { semanticMinMatch: 65 }
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(updateSiteCalls.at(-1), [
    SITE_ID,
    { config: { search: { config: { semanticMinMatch: 65 } } } }
  ])
})

test('PATCH .../search stores semanticMinMatch alongside semanticEnabled', async () => {
  ;(globalThis as any).CARDINAL.capabilities = { semanticSearch: true }
  const res = await app.inject({
    method: 'PATCH',
    url: `/sites/${SITE_ID}/search`,
    payload: { semanticEnabled: true, semanticMinMatch: 0 }
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(updateSiteCalls.at(-1), [
    SITE_ID,
    { config: { search: { config: { semanticEnabled: true, semanticMinMatch: 0 } } } }
  ])
})

for (const invalid of [-1, 101, 50.5, 'high']) {
  test(`PATCH .../search rejects semanticMinMatch: ${JSON.stringify(invalid)}`, async () => {
    const callsBefore = updateSiteCalls.length
    const res = await app.inject({
      method: 'PATCH',
      url: `/sites/${SITE_ID}/search`,
      payload: { semanticMinMatch: invalid }
    })
    assert.equal(res.statusCode, 400)
    assert.equal(updateSiteCalls.length, callsBefore)
  })
}

test('GET .../search/semantic 404s for a site that does not exist', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/sites/22222222-2222-2222-2222-222222222222/search/semantic'
  })
  assert.equal(res.statusCode, 404)
})

test('GET .../search/semantic reports the stored setting and the instance capability', async () => {
  semanticEnabled = true
  semanticMinMatch = 40
  ;(globalThis as any).CARDINAL.capabilities = { semanticSearch: false }
  const res = await app.inject({ method: 'GET', url: `/sites/${SITE_ID}/search/semantic` })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { enabled: true, available: false, minMatch: 40 })
  semanticEnabled = false
  semanticMinMatch = 0
})

test('POST .../search/rebuild-embeddings 400s when the capability is unavailable', async () => {
  ;(globalThis as any).CARDINAL.capabilities = { semanticSearch: false }
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/search/rebuild-embeddings`
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().message, 'ERR_SEMANTIC_SEARCH_UNAVAILABLE')
})

test('POST .../search/rebuild-embeddings 404s for a site that does not exist', async () => {
  ;(globalThis as any).CARDINAL.capabilities = { semanticSearch: true }
  const res = await app.inject({
    method: 'POST',
    url: '/sites/22222222-2222-2222-2222-222222222222/search/rebuild-embeddings'
  })
  assert.equal(res.statusCode, 404)
})

test('POST .../search/rebuild-embeddings queues the job and returns its id when the capability is available', async () => {
  ;(globalThis as any).CARDINAL.capabilities = { semanticSearch: true }
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/search/rebuild-embeddings`
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)
  assert.equal(res.json().id, 'test-job')
})
