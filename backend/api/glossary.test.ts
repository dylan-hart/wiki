import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { randomUUID } from 'node:crypto'
import { siteEnabledPreHandler } from '../helpers/siteResolution.ts'
import glossaryRoutes from './glossary.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

/**
 * Route-level coverage for `api/glossary.ts` (OpenProject #870), against a fake `WIKI.models.glossary`
 * rather than a real one — what these tests cover is the route's own site-existence guard and
 * field-forwarding, not the model itself (DB-backed coverage lives in `models/glossary.test.ts`).
 * Mirrors `hooks.test.ts`'s own recording-fake pattern.
 */

const SITE_1_ID = randomUUID()
const UNKNOWN_SITE_ID = randomUUID()
const TERM_ID = randomUUID()
const ACTOR_SENTINEL = { groupIds: ['sentinel-group'], permissions: [] }

const VERSION_ID = randomUUID()

let app: FastifyInstance
let listTermsCalls: any[]
let getCachedTermsCalls: any[]
let createTermCalls: any[]
let updateTermCalls: any[]
let deleteTermCalls: any[]
let deleteTermResult: boolean
let exportTermsCalls: any[]
let importTermsCalls: any[]
let saveVersionCalls: any[]
let listVersionsCalls: any[]
let getVersionCalls: any[]
let getVersionResult: any
let restoreVersionCalls: any[]

before(async () => {
  // -> The unknown-site 404 lives in one hook now (spec D1), not in each route handler, so a
  //    plugin-only app has to register it to answer that case the way the real app does. Wrapped
  //    around the route plugin so it runs inside the same encapsulation the routes are in.
  const guardedRoutes: FastifyPluginAsync = async (instance) => {
    instance.addHook('preHandler', siteEnabledPreHandler)
    await instance.register(glossaryRoutes)
  }
  app = await buildTestApp({
    routes: guardedRoutes,
    wiki: {
      sites: { [SITE_1_ID]: { id: SITE_1_ID, config: {} } },
      models: {
        groups: {
          // -> OpenProject #1127: the route hands this straight to `getCachedTerms` as its `actor` --
          //    a fixed sentinel is enough to prove the wiring, since permission filtering itself is
          //    `models/groups.ts`/`models/glossary.ts`'s own DB-backed coverage, not this route's.
          actorForRequest: () => ACTOR_SENTINEL
        },
        glossary: {
          listTerms: async (siteId: string) => {
            listTermsCalls.push(siteId)
            return [{ id: TERM_ID, term: 'API', definition: 'Application Programming Interface.' }]
          },
          getCachedTerms: async (siteId: string, actor: any) => {
            getCachedTermsCalls.push({ siteId, actor })
            return [{ term: 'API', definition: 'Application Programming Interface.', link: null }]
          },
          createTerm: async (siteId: string, values: any) => {
            createTermCalls.push({ siteId, values })
            return { id: 'new-term-id', ...values }
          },
          updateTerm: async (siteId: string, id: string, values: any) => {
            updateTermCalls.push({ siteId, id, values })
            return { id, term: 'API', definition: 'Updated.', pageId: null, ...values }
          },
          deleteTerm: async (siteId: string, id: string) => {
            deleteTermCalls.push({ siteId, id })
            return deleteTermResult
          },
          exportTerms: async (siteId: string) => {
            exportTermsCalls.push(siteId)
            return { formatVersion: 1, terms: [] }
          },
          importTerms: async (siteId: string, data: any) => {
            importTermsCalls.push({ siteId, data })
            return [{ id: 'imported-1', ...data.terms[0] }]
          },
          saveVersion: async (siteId: string, terms: any, actor: any) => {
            saveVersionCalls.push({ siteId, terms, actor })
            return {
              terms: terms.map((t: any, i: number) => ({ id: `saved-${i}`, ...t })),
              version: { id: VERSION_ID, termCount: terms.length, actorId: null, actorName: '' }
            }
          },
          listVersions: async (siteId: string) => {
            listVersionsCalls.push(siteId)
            return [{ id: VERSION_ID, termCount: 1, actorId: null, actorName: '' }]
          },
          getVersion: async (siteId: string, versionId: string) => {
            getVersionCalls.push({ siteId, versionId })
            return getVersionResult
          },
          restoreVersion: async (siteId: string, versionId: string, actor: any) => {
            restoreVersionCalls.push({ siteId, versionId, actor })
            return {
              terms: [],
              version: { id: 'restored-version', termCount: 0, actorId: null, actorName: '' }
            }
          }
        }
      }
    }
  })
})

after(() => closeTestApp(app))

beforeEach(() => {
  listTermsCalls = []
  getCachedTermsCalls = []
  createTermCalls = []
  updateTermCalls = []
  deleteTermCalls = []
  deleteTermResult = true
  exportTermsCalls = []
  importTermsCalls = []
  saveVersionCalls = []
  listVersionsCalls = []
  getVersionCalls = []
  getVersionResult = {
    id: VERSION_ID,
    termCount: 0,
    actorId: null,
    actorName: '',
    snapshot: { formatVersion: 1, terms: [] }
  }
  restoreVersionCalls = []
})

test('GET /sites/:siteId/glossary answers 404 for an unknown site', async () => {
  const res = await app.inject({ method: 'GET', url: `/sites/${UNKNOWN_SITE_ID}/glossary` })
  assert.equal(res.statusCode, 404)
  assert.equal(listTermsCalls.length, 0)
})

test('GET /sites/:siteId/glossary lists this site’s terms', async () => {
  const res = await app.inject({ method: 'GET', url: `/sites/${SITE_1_ID}/glossary` })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(listTermsCalls, [SITE_1_ID])
  assert.equal(res.json()[0].term, 'API')
})

test('GET /sites/:siteId/glossary/terms answers 404 for an unknown site', async () => {
  const res = await app.inject({ method: 'GET', url: `/sites/${UNKNOWN_SITE_ID}/glossary/terms` })
  assert.equal(res.statusCode, 404)
  assert.equal(getCachedTermsCalls.length, 0)
})

test('GET /sites/:siteId/glossary/terms returns the resolved, cached list', async () => {
  const res = await app.inject({ method: 'GET', url: `/sites/${SITE_1_ID}/glossary/terms` })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(getCachedTermsCalls, [{ siteId: SITE_1_ID, actor: ACTOR_SENTINEL }])
  assert.deepEqual(res.json(), [
    { term: 'API', definition: 'Application Programming Interface.', link: null }
  ])
})

test('POST /sites/:siteId/glossary answers 404 for an unknown site', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${UNKNOWN_SITE_ID}/glossary`,
    payload: { term: 'API', definition: 'Application Programming Interface.' }
  })
  assert.equal(res.statusCode, 404)
  assert.equal(createTermCalls.length, 0)
})

test('POST /sites/:siteId/glossary forwards term/definition/aliases/pageId to createTerm', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_1_ID}/glossary`,
    payload: {
      term: 'API',
      definition: 'Application Programming Interface.',
      aliases: ['REST API'],
      pageId: TERM_ID
    }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(createTermCalls.length, 1)
  assert.equal(createTermCalls[0].siteId, SITE_1_ID)
  assert.deepEqual(createTermCalls[0].values, {
    term: 'API',
    definition: 'Application Programming Interface.',
    aliases: ['REST API'],
    pageId: TERM_ID
  })
})

test('POST /sites/:siteId/glossary defaults aliases to an empty array when omitted', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_1_ID}/glossary`,
    payload: { term: 'API', definition: 'Application Programming Interface.' }
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(createTermCalls[0].values.aliases, [])
})

test('POST /sites/:siteId/glossary rejects a body missing term or definition', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_1_ID}/glossary`,
    payload: { term: 'API' }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(createTermCalls.length, 0)
})

test('PUT /sites/:siteId/glossary/:termId forwards only the fields given', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/sites/${SITE_1_ID}/glossary/${TERM_ID}`,
    payload: { definition: 'Updated definition.' }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(updateTermCalls.length, 1)
  assert.equal(updateTermCalls[0].id, TERM_ID)
  assert.equal(updateTermCalls[0].values.definition, 'Updated definition.')
  assert.equal(updateTermCalls[0].values.term, undefined)
})

test('PUT /sites/:siteId/glossary/:termId can explicitly clear pageId back to null', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/sites/${SITE_1_ID}/glossary/${TERM_ID}`,
    payload: { pageId: null }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(updateTermCalls[0].values.pageId, null)
})

test('DELETE /sites/:siteId/glossary/:termId answers 200 { ok: true } on success', async () => {
  deleteTermResult = true
  const res = await app.inject({
    method: 'DELETE',
    url: `/sites/${SITE_1_ID}/glossary/${TERM_ID}`
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true })
  assert.deepEqual(deleteTermCalls, [{ siteId: SITE_1_ID, id: TERM_ID }])
})

test('DELETE /sites/:siteId/glossary/:termId answers 404 when nothing was deleted', async () => {
  deleteTermResult = false
  const res = await app.inject({
    method: 'DELETE',
    url: `/sites/${SITE_1_ID}/glossary/${TERM_ID}`
  })
  assert.equal(res.statusCode, 404)
})

/**
 * Export / import / save / versions (OpenProject #1113, #1114) -- same fake-model, route-forwarding
 * coverage as the CRUD routes above.
 */

test('GET /sites/:siteId/glossary/export answers 404 for an unknown site', async () => {
  const res = await app.inject({ method: 'GET', url: `/sites/${UNKNOWN_SITE_ID}/glossary/export` })
  assert.equal(res.statusCode, 404)
  assert.equal(exportTermsCalls.length, 0)
})

test('GET /sites/:siteId/glossary/export forwards to exportTerms', async () => {
  const res = await app.inject({ method: 'GET', url: `/sites/${SITE_1_ID}/glossary/export` })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(exportTermsCalls, [SITE_1_ID])
  assert.deepEqual(res.json(), { formatVersion: 1, terms: [] })
})

test('POST /sites/:siteId/glossary/import forwards the body to importTerms', async () => {
  const payload = { formatVersion: 1, terms: [{ term: 'API', definition: 'Def.', path: null }] }
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_1_ID}/glossary/import`,
    payload
  })
  assert.equal(res.statusCode, 200)
  assert.equal(importTermsCalls.length, 1)
  assert.equal(importTermsCalls[0].siteId, SITE_1_ID)
  // -> The body schema defaults each term's `aliases` to `[]` when omitted, same as the create route
  assert.deepEqual(importTermsCalls[0].data, {
    ...payload,
    terms: [{ ...payload.terms[0], aliases: [] }]
  })
})

test('POST /sites/:siteId/glossary/save forwards terms and the resolved actor to saveVersion', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_1_ID}/glossary/save`,
    payload: { terms: [{ term: 'API', definition: 'Def.' }] }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(saveVersionCalls.length, 1)
  assert.equal(saveVersionCalls[0].siteId, SITE_1_ID)
  assert.equal(saveVersionCalls[0].terms[0].term, 'API')
  // -> No session/API key on a bare `inject()` call -- actorFromRequest resolves to the "nobody" shape
  assert.deepEqual(saveVersionCalls[0].actor, { id: null, name: '', ip: '127.0.0.1' })
  assert.equal(res.json().version.id, VERSION_ID)
})

test('POST /sites/:siteId/glossary/save rejects a term missing a definition', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_1_ID}/glossary/save`,
    payload: { terms: [{ term: 'API' }] }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(saveVersionCalls.length, 0)
})

test('GET /sites/:siteId/glossary/versions forwards to listVersions', async () => {
  const res = await app.inject({ method: 'GET', url: `/sites/${SITE_1_ID}/glossary/versions` })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(listVersionsCalls, [SITE_1_ID])
  assert.equal(res.json()[0].id, VERSION_ID)
})

test('GET /sites/:siteId/glossary/versions/:versionId answers 404 when the version is missing', async () => {
  getVersionResult = null
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_1_ID}/glossary/versions/${VERSION_ID}`
  })
  assert.equal(res.statusCode, 404)
})

test('GET /sites/:siteId/glossary/versions/:versionId returns the full version', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_1_ID}/glossary/versions/${VERSION_ID}`
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(getVersionCalls, [{ siteId: SITE_1_ID, versionId: VERSION_ID }])
  assert.equal(res.json().id, VERSION_ID)
})

test('POST /sites/:siteId/glossary/versions/:versionId/restore forwards to restoreVersion', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_1_ID}/glossary/versions/${VERSION_ID}/restore`
  })
  assert.equal(res.statusCode, 200)
  assert.equal(restoreVersionCalls.length, 1)
  assert.deepEqual(restoreVersionCalls[0].siteId, SITE_1_ID)
  assert.equal(restoreVersionCalls[0].versionId, VERSION_ID)
  assert.equal(res.json().version.id, 'restored-version')
})
