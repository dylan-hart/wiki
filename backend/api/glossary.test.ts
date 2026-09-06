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
 *
 * Trimmed by OpenProject #2690 (`docs/testing-audit/backend.md`'s `api/glossary.test.ts` row, and
 * `docs/decisions/testing-strategy.md`'s worked example of the same file): most of the original
 * twenty-four tests were the shape "the route forwards these fields to the model unchanged," and the
 * unknown-site 404 repeated on every route came free from `siteEnabledPreHandler`, already covered
 * once, structurally, by `api/index.test.ts`. Body-shape validation is enforced by the JSON Schema
 * declared in `glossary.ts` itself. What survives here is the handful of tests documenting a real,
 * non-obvious branch: an asymmetric schema default, partial-update semantics that must not clobber an
 * untouched field, an explicit-null vs. omitted distinction, and the two genuine not-found branches.
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
  // -> Unlike `aliases`, the schema deliberately carries no `default` for `isAcronym` (see its own
  //    schema comment) -- an omitted value stays `undefined` here; `models/glossary.ts#createTerm`'s
  //    own `!!input.isAcronym` is what turns that into a stored `false`, not a JSON Schema default.
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
  // -> OpenProject #2575: `isAcronym` carries no schema default (see its schema comment) precisely
  //    so a partial update like this one -- touching only `definition` -- does not also silently
  //    forward `isAcronym: false` and clear an existing acronym flag.
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
