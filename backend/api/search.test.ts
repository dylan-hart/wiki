import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import searchRoutes from './search.ts'
import { registerSchemas as registerSearchSchema } from './schemas/search.ts'

/**
 * Route-level tests for the engine-picker endpoints added on top of `api/search.ts` (task #570):
 * `GET/PUT .../search/engines[/:key]` and `POST .../search/refresh`. Boots a bare Fastify instance
 * with only this plugin and its schema registered -- no `config.permissions` preHandler, since that
 * hook lives in `index.ts` and is out of scope here; this covers the route handlers' own logic
 * (site/engine lookup, validation, response shape), the same boundary `api/sites.test.ts` draws.
 *
 * `WIKI.models.search` is stubbed rather than pulling in the real disk-scanning model, keeping this a
 * self-contained test of the routes' wiring to whatever the model returns/throws.
 */

const SITE_ID = '11111111-1111-1111-1111-111111111111'
const sites: Record<string, any> = {
  [SITE_ID]: { id: SITE_ID, config: {} }
}

function makeDbEngine() {
  return {
    key: 'db',
    title: 'Database',
    description: 'PostgreSQL full-text search.',
    vendor: 'Wiki.js',
    website: 'https://js.wiki',
    props: { termHighlighting: { type: 'boolean', title: 'Term Highlighting', default: false } },
    hasImplementation: false,
    isSelected: true,
    config: { termHighlighting: false }
  }
}

// -> What `GET .../search/engines` and `POST .../refresh` are expected to end up with once
//    `withDbSearchExtras` (task #574) attaches these onto the `db` entry
const dictOverrides = { en: 'english' }
const availableDictionaries = ['english', 'simple']

let app: FastifyInstance
let refreshCalls: number
let selectCalls: any[]
let validateResult: string | null

before(async () => {
  refreshCalls = 0
  selectCalls = []
  validateResult = null

  ;(globalThis as any).WIKI = {
    models: {
      sites: {
        getSiteById: async ({ id }: { id: string }) => sites[id] ?? null
      },
      search: {
        // -> A fresh object per call: `withDbSearchExtras` mutates the `db` entry it's handed, and a
        //    shared object here would let one test's mutation leak into the next test's assertions
        getSiteEngines: async (siteId: string) => (sites[siteId] ? [makeDbEngine()] : []),
        getDefinition: (key: string) => (key === 'db' ? makeDbEngine() : null),
        validateEngineConfig: (_key: string, _incoming: any) => validateResult,
        selectEngine: async (siteId: string, key: string, incoming: any) => {
          selectCalls.push([siteId, key, incoming])
          return true
        },
        refreshFromDisk: async () => {
          refreshCalls++
        },
        getConfig: (_siteId: string) => ({ dictOverrides }),
        getAvailableDictionaries: async () => availableDictionaries
      }
    }
  }

  app = fastify({
    ajv: {
      plugins: [[ajvFormats.default, {}] as any]
    }
  })
  await app.register(fastifySensible)
  await registerSearchSchema(app)
  await app.register(searchRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
})

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
