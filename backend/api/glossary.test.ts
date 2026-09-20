import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { randomUUID } from 'node:crypto'
import { siteEnabledPreHandler } from '../helpers/siteResolution.ts'
import glossaryRoutes from './glossary.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

/**
 * Against a fake `CARDINAL.models.glossary`; the model's own coverage is `models/glossary.test.ts`.
 * Plain field-forwarding and the per-route unknown-site 404 deliberately get no test here: only a
 * non-obvious branch earns one.
 */

const SITE_1_ID = randomUUID()
const TERM_ID = randomUUID()
const ACTOR_SENTINEL = { groupIds: ['sentinel-group'], permissions: [] }

const VERSION_ID = randomUUID()

let app: FastifyInstance
let createTermCalls: any[]
let updateTermCalls: any[]
let deleteTermCalls: any[]
let deleteTermResult: boolean
let getVersionCalls: any[]
let getVersionResult: any
let queueRerenderAllPagesCalls: any[]
let queueRerenderAllPagesResult: number

before(async () => {
  // -> The unknown-site 404 is `siteEnabledPreHandler`'s, which a plugin-only app must register
  //    itself — wrapped around the route plugin so it shares the routes' encapsulation.
  const guardedRoutes: FastifyPluginAsync = async (instance) => {
    instance.addHook('preHandler', siteEnabledPreHandler)
    await instance.register(glossaryRoutes)
  }
  app = await buildTestApp({
    routes: guardedRoutes,
    session: 'header',
    wiki: {
      sites: { [SITE_1_ID]: { id: SITE_1_ID, config: {} } },
      models: {
        // -> Consulted by the rerender-all-pages route's `limitRenders` preHandler.
        rateLimits: {
          consume: async () => ({ allowed: true, hits: 1, retryAfter: 0 })
        },
        groups: {
          actorForRequest: () => ACTOR_SENTINEL,
          // -> `actorFrom()` calls this for a session-based caller.
          groupIdsForRequest: () => []
        },
        pages: {
          queueRerenderAllPages: async (siteId: string, actor: any) => {
            queueRerenderAllPagesCalls.push({ siteId, actor })
            return queueRerenderAllPagesResult
          }
        },
        glossary: {
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
          getVersion: async (siteId: string, versionId: string) => {
            getVersionCalls.push({ siteId, versionId })
            return getVersionResult
          }
        }
      }
    }
  })
})

after(() => closeTestApp(app))

beforeEach(() => {
  createTermCalls = []
  updateTermCalls = []
  deleteTermCalls = []
  deleteTermResult = true
  getVersionCalls = []
  queueRerenderAllPagesCalls = []
  queueRerenderAllPagesResult = 0
  getVersionResult = {
    id: VERSION_ID,
    termCount: 0,
    actorId: null,
    actorName: '',
    snapshot: { formatVersion: 1, terms: [] }
  }
})

test('POST /sites/:siteId/glossary defaults aliases to an empty array when omitted, and leaves isAcronym undefined', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_1_ID}/glossary`,
    payload: { term: 'API', definition: 'Application Programming Interface.' }
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(createTermCalls[0].values.aliases, [])
  // -> Unlike `aliases`, `isAcronym` carries no schema `default`; `createTerm`'s own
  //    `!!input.isAcronym` is what stores `false`.
  assert.equal(createTermCalls[0].values.isAcronym, undefined)
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
  // -> A schema default would forward `isAcronym: false` here and clear an existing flag.
  assert.equal(updateTermCalls[0].values.isAcronym, undefined)
})

test('PUT /sites/:siteId/glossary/:termId forwards an explicit isAcronym', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/sites/${SITE_1_ID}/glossary/${TERM_ID}`,
    payload: { isAcronym: true }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(updateTermCalls[0].values.isAcronym, true)
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

test('DELETE /sites/:siteId/glossary/:termId answers 404 when nothing was deleted', async () => {
  deleteTermResult = false
  const res = await app.inject({
    method: 'DELETE',
    url: `/sites/${SITE_1_ID}/glossary/${TERM_ID}`
  })
  assert.equal(res.statusCode, 404)
  assert.deepEqual(deleteTermCalls, [{ siteId: SITE_1_ID, id: TERM_ID }])
})

test('GET /sites/:siteId/glossary/versions/:versionId answers 404 when the version is missing', async () => {
  getVersionResult = null
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_1_ID}/glossary/versions/${VERSION_ID}`
  })
  assert.equal(res.statusCode, 404)
  assert.deepEqual(getVersionCalls, [{ siteId: SITE_1_ID, versionId: VERSION_ID }])
})

test('POST /sites/:siteId/glossary/rerender-all-pages queues every page and reports the count', async () => {
  queueRerenderAllPagesResult = 3
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_1_ID}/glossary/rerender-all-pages`,
    headers: {
      'x-test-session': JSON.stringify({
        authenticated: true,
        user: { id: 'actor-1' },
        permissions: ['manage:glossary']
      })
    }
  })
  assert.equal(res.statusCode, 202)
  assert.deepEqual(JSON.parse(res.body), { ok: true, queued: 3 })
  assert.equal(queueRerenderAllPagesCalls.length, 1)
  assert.equal(queueRerenderAllPagesCalls[0].siteId, SITE_1_ID)
})

test('POST /sites/:siteId/glossary/rerender-all-pages answers 401 with no logged-in caller', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_1_ID}/glossary/rerender-all-pages`
  })
  assert.equal(res.statusCode, 401)
  assert.deepEqual(queueRerenderAllPagesCalls, [])
})
