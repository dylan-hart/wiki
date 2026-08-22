import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import { randomUUID } from 'node:crypto'
import glossaryRoutes from './glossary.ts'
import { registerSchemas as registerGlossarySchema } from './schemas/glossaryTerm.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'

/**
 * Route-level coverage for `api/glossary.ts` (OpenProject #870), against a fake `WIKI.models.glossary`
 * rather than a real one — what these tests cover is the route's own site-existence guard and
 * field-forwarding, not the model itself (DB-backed coverage lives in `models/glossary.test.ts`).
 * Mirrors `hooks.test.ts`'s own recording-fake pattern.
 */

const SITE_1_ID = randomUUID()
const UNKNOWN_SITE_ID = randomUUID()
const TERM_ID = randomUUID()

let app: FastifyInstance
let listTermsCalls: any[]
let getCachedTermsCalls: any[]
let createTermCalls: any[]
let updateTermCalls: any[]
let deleteTermCalls: any[]
let deleteTermResult: boolean

before(async () => {
  app = fastify()
  await app.register(fastifySensible)
  // -> Mirrors `index.ts`'s real `setErrorHandler` -- see `hooks.test.ts`'s identical comment
  app.setErrorHandler((error: any, req, reply) => {
    reply.code(error.statusCode ?? 500).send({
      ok: false,
      error: error.name,
      statusCode: error.statusCode ?? 500,
      message: error.message
    })
  })
  await registerGlossarySchema(app)
  await registerErrorSchema(app)
  await app.register(glossaryRoutes)
  await app.ready()

  ;(globalThis as any).WIKI = {
    sites: { [SITE_1_ID]: { id: SITE_1_ID, config: {} } },
    models: {
      glossary: {
        listTerms: async (siteId: string) => {
          listTermsCalls.push(siteId)
          return [{ id: TERM_ID, term: 'API', definition: 'Application Programming Interface.' }]
        },
        getCachedTerms: async (siteId: string) => {
          getCachedTermsCalls.push(siteId)
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
        }
      }
    }
  }
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

beforeEach(() => {
  listTermsCalls = []
  getCachedTermsCalls = []
  createTermCalls = []
  updateTermCalls = []
  deleteTermCalls = []
  deleteTermResult = true
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
  assert.deepEqual(getCachedTermsCalls, [SITE_1_ID])
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

test('POST /sites/:siteId/glossary forwards term/definition/pageId to createTerm', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_1_ID}/glossary`,
    payload: { term: 'API', definition: 'Application Programming Interface.', pageId: TERM_ID }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(createTermCalls.length, 1)
  assert.equal(createTermCalls[0].siteId, SITE_1_ID)
  assert.deepEqual(createTermCalls[0].values, {
    term: 'API',
    definition: 'Application Programming Interface.',
    pageId: TERM_ID
  })
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
