import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import { siteEnabledPreHandler } from '../helpers/siteResolution.ts'
import searchRoutes from './search.ts'
import { registerSchemas as registerSearchSchema } from './schemas/search.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'
import { registerParamsSchemas } from './schemas/params.ts'

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

// -> What `getEngineConfig` reports as already stored for the site's `db` engine, task #556: the PUT
//    route must pass this through to `validateEngineConfig` as its `existing` argument so a required
//    prop already saved does not need to be resent just to keep validating.
const storedEngineConfig = { termHighlighting: false }

let app: FastifyInstance
let refreshCalls: number
let selectCalls: any[]
let validateCalls: any[]
let validateResult: string | null

before(async () => {
  refreshCalls = 0
  selectCalls = []
  validateCalls = []
  validateResult = null

  ;(globalThis as any).WIKI = {
    sites,
    models: {
      search: {
        // -> A fresh object per call: `withDbSearchExtras` mutates the `db` entry it's handed, and a
        //    shared object here would let one test's mutation leak into the next test's assertions
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
  await registerErrorSchema(app)
  await registerSearchSchema(app)
  // -> The unknown-site 404 lives in this one hook now (spec D1), not in each route handler, so a
  //    plugin-only app has to register it to answer that case the way the real app does.
  app.addHook('preHandler', siteEnabledPreHandler)
  await registerParamsSchemas(app)
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

// -> #1616: these two messages used to be free-text English sentences, which surfaced verbatim in
//    the UI instead of translating like the rest of a `t(key, fallback)` screen. Assert the coded
//    `ERR_*` shape (`frontend/src/helpers/localization.js#localizeError` is what resolves it client
//    side) rather than any particular English wording.
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
