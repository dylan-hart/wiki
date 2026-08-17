import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import pagesRoutes from './pages.ts'
import { registerSchemas as registerPageSchema } from './schemas/page.ts'
import { registerSchemas as registerApprovalSchema } from './schemas/approval.ts'

/**
 * Route-wiring proof for `enforceApiKeySite` (`helpers/apiKeySite.ts`), on the two routes it was
 * wired into as this task's representative surface: `GET /sites/:siteId/pages/:pageIdOrHash` and
 * `POST /sites/:siteId/pages`. The helper's own behavior (null vs. matching vs. mismatched siteId) is
 * unit-tested in `helpers/apiKeySite.test.ts`; this file only proves it is actually reached first in
 * real route handlers, ahead of any model call — real route registration, real schemas, real
 * `@fastify/sensible` `reply.forbidden()`.
 *
 * `req.apiKey` is attached by a fixture `onRequest` hook that reads it off an `x-test-api-key` test
 * header, the same shape `models/apiKeys.ts#verify()` produces at runtime — nothing about the routes
 * themselves is test-specific.
 *
 * `WIKI.models.pages.getPage` is stubbed to return `null` so a request that clears the site-scope gate
 * falls through to the ordinary "page does not exist" 404 — which needs no `Page#` response payload —
 * rather than requiring a full page object satisfying that schema just to prove the gate was passed.
 */

const SITE_A = '11111111-1111-4111-8111-111111111111'
const SITE_B = '22222222-2222-4222-8222-222222222222'
const PAGE_HASH = 'ab'.repeat(16)

let getPageCalls: any[] = []
let createPageCalls: any[] = []

let app: FastifyInstance

before(async () => {
  ;(globalThis as any).WIKI = {
    models: {
      pages: {
        getPage: async (args: any) => {
          getPageCalls.push(args)
          return null
        },
        createPage: async (...args: any[]) => {
          createPageCalls.push(args)
          return { id: 'new-page-id' }
        }
      },
      groups: {
        actorForRequest: () => ({ permissions: [] }),
        checkAccess: () => true
      }
    }
  }

  app = fastify()
  await app.register(fastifySensible)
  app.addHook('onRequest', async (req) => {
    const rawKey = req.headers['x-test-api-key']
    if (typeof rawKey === 'string') {
      ;(req as any).apiKey = JSON.parse(rawKey)
    }
    const rawSession = req.headers['x-test-session']
    if (typeof rawSession === 'string') {
      ;(req as any).session = JSON.parse(rawSession)
    }
  })
  await registerApprovalSchema(app)
  await registerPageSchema(app)
  await app.register(pagesRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

beforeEach(() => {
  getPageCalls = []
  createPageCalls = []
})

function apiKeyHeader(siteId: string | null) {
  return { 'x-test-api-key': JSON.stringify({ id: 'key-1', permissions: [], siteId }) }
}

test('GET page: refuses with 403 before touching the model when the key is scoped to a different site', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_A}/pages/${PAGE_HASH}`,
    headers: apiKeyHeader(SITE_B)
  })
  assert.equal(res.statusCode, 403)
  assert.equal(getPageCalls.length, 0)
})

test('GET page: reaches the model when the key is scoped to the matching site', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_A}/pages/${PAGE_HASH}`,
    headers: apiKeyHeader(SITE_A)
  })
  assert.equal(res.statusCode, 404) // -> past the gate, into the ordinary "page not found" path
  assert.equal(getPageCalls.length, 1)
})

test('GET page: reaches the model when the key is unscoped (siteId: null)', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_A}/pages/${PAGE_HASH}`,
    headers: apiKeyHeader(null)
  })
  assert.equal(res.statusCode, 404)
  assert.equal(getPageCalls.length, 1)
})

test('CREATE page: refuses with 403 before touching the model when the key is scoped to a different site', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_A}/pages`,
    headers: apiKeyHeader(SITE_B),
    payload: { path: 'test-page', title: 'Test', editor: 'markdown', content: 'hello' }
  })
  assert.equal(res.statusCode, 403)
  assert.equal(createPageCalls.length, 0)
})

test('CREATE page: passes the gate and reaches the model when the key is scoped to the matching site', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_A}/pages`,
    headers: {
      ...apiKeyHeader(SITE_A),
      'x-test-session': JSON.stringify({
        authenticated: true,
        user: { id: 'user-1' },
        permissions: []
      })
    },
    payload: { path: 'test-page', title: 'Test', editor: 'markdown', content: 'hello' }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(createPageCalls.length, 1)
})

test('CREATE page: refused by the ordinary unauthenticated check, not the site gate, when the key is unscoped and there is no session', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_A}/pages`,
    headers: apiKeyHeader(null),
    payload: { path: 'test-page', title: 'Test', editor: 'markdown', content: 'hello' }
  })
  // -> Past the site-scope gate (unscoped key): refused next by `actorFrom` (no session).
  assert.equal(res.statusCode, 401)
  assert.equal(createPageCalls.length, 0)
})
