import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import hooksRoutes from './hooks.ts'
import { registerSchemas as registerHookSchema } from './schemas/hook.ts'

/** A site that "exists" for the `siteId` validation in `invalidReason()`, and one that never does. */
const SITE_1_ID = randomUUID()
const UNKNOWN_SITE_ID = randomUUID()
const EXISTING_HOOK_ID = randomUUID()

/**
 * `POST /_api/hooks/test` sends a synthetic delivery to whatever `url`/`authHeader`/`acceptUntrusted`
 * is in the body — no `hookId` — so `WebhookEditDialog.vue` can validate an endpoint before the
 * webhook is ever saved, and `AdminWebhooks.vue`'s per-row button can re-validate a saved one by
 * passing its stored fields through the same shape. It must never write to the hooks table: a test
 * delivery is not a real delivery.
 *
 * Exercised against a real local HTTP server rather than a mocked `postJson()`, since the whole point
 * of the route is what actually happens over the wire (status code passthrough, auth header, a
 * connection failure reported as `ok: false` rather than thrown).
 */

let app: FastifyInstance
let server: http.Server
let serverUrl: string
let lastRequestHeaders: http.IncomingHttpHeaders | null = null
let lastRequestBody = ''
let responseStatus = 200
let previousTemporal: any
let createHookCalls: any[]
let updateHookCalls: any[]
let existingHook: any

/**
 * Minimal stand-in for the subset of `Temporal.Instant` the route touches (`Now.instant()`,
 * `.toString({ smallestUnit })`).
 *
 * CLAUDE.md documents `Temporal` as a Node 26 global needing no import, but this sandbox's `node` is
 * v25.9.0, which doesn't expose it (same environment gap noted in `core/scheduler.test.ts` and tasks
 * 753/756/757/760/761 — not a spec deviation).
 */
function installFakeTemporal(): void {
  ;(globalThis as any).Temporal = {
    Now: { instant: () => ({ toString: () => new Date().toISOString() }) }
  }
}

before(async () => {
  previousTemporal = (globalThis as any).Temporal
  installFakeTemporal()
  ;(globalThis as any).WIKI = {
    version: 'test',
    INSTANCE_ID: 'test-instance',
    logger: { warn: () => {}, debug: () => {} },
    sites: { [SITE_1_ID]: { id: SITE_1_ID, config: {} } },
    models: {
      hooks: {
        createHook: async (values: any) => {
          createHookCalls.push(values)
          return 'new-hook-id'
        },
        updateHook: async (id: string, patch: any) => {
          updateHookCalls.push({ id, patch })
          return true
        },
        getHookById: async (id: string) => (id === existingHook?.id ? existingHook : null)
      }
    }
  }

  server = http.createServer((req, res) => {
    lastRequestHeaders = req.headers
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      lastRequestBody = body
      res.writeHead(responseStatus)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  serverUrl = `http://127.0.0.1:${port}/`

  app = fastify()
  await app.register(fastifySensible)
  await registerHookSchema(app)
  await app.register(hooksRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  delete (globalThis as any).WIKI
  ;(globalThis as any).Temporal = previousTemporal
})

beforeEach(() => {
  responseStatus = 200
  lastRequestHeaders = null
  lastRequestBody = ''
  createHookCalls = []
  updateHookCalls = []
  existingHook = {
    id: EXISTING_HOOK_ID,
    name: 'Existing',
    url: 'https://example.com',
    siteId: null
  }
})

test('a successful (2xx) response reports ok:true with the status code', async () => {
  responseStatus = 204
  const res = await app.inject({
    method: 'POST',
    url: '/test',
    payload: { url: serverUrl }
  })
  assert.equal(res.statusCode, 200)
  const json = res.json()
  assert.equal(json.ok, true)
  assert.equal(json.statusCode, 204)
})

test('a non-2xx response reports ok:false with the status code, not an HTTP error', async () => {
  responseStatus = 500
  const res = await app.inject({
    method: 'POST',
    url: '/test',
    payload: { url: serverUrl }
  })
  assert.equal(res.statusCode, 200)
  const json = res.json()
  assert.equal(json.ok, false)
  assert.equal(json.statusCode, 500)
})

test('sends the auth header and a synthetic hook:test payload', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/test',
    payload: { url: serverUrl, authHeader: 'Bearer abc123' }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(lastRequestHeaders?.authorization, 'Bearer abc123')
  const sent = JSON.parse(lastRequestBody)
  assert.equal(sent.event, 'hook:test')
  assert.equal(typeof sent.data?.message, 'string')
})

test('an invalid url is rejected with 400 before any request is attempted', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/test',
    payload: { url: 'not-a-url' }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(lastRequestHeaders, null)
})

test('a connection failure is reported as ok:false with statusCode 0 rather than thrown', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/test',
    // -> Nothing listens on this port; the request must fail to connect
    payload: { url: 'http://127.0.0.1:1/' }
  })
  assert.equal(res.statusCode, 200)
  const json = res.json()
  assert.equal(json.ok, false)
  assert.equal(json.statusCode, 0)
  assert.ok(json.message)
})

/**
 * `POST /hooks` and `PUT /hooks/:hookId` thread the new `siteId` field through to
 * `WIKI.models.hooks.createHook()`/`updateHook()`, and reject one that names a site the instance
 * doesn't have -- against a fake `WIKI.models.hooks` rather than a real one, since what these tests
 * cover is the route's own validation and field-forwarding, not the model (which has its own
 * DB-backed coverage in `models/hooks.test.ts`).
 */
test('create defaults siteId to null when omitted', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: { name: 'My Hook', events: ['page:create'], url: 'https://example.com/hook' }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(createHookCalls.length, 1)
  assert.equal(createHookCalls[0].siteId, null)
})

test('create forwards a valid siteId', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: {
      name: 'My Hook',
      events: ['page:create'],
      url: 'https://example.com/hook',
      siteId: SITE_1_ID
    }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(createHookCalls[0].siteId, SITE_1_ID)
})

test('create rejects a siteId that names no known site', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: {
      name: 'My Hook',
      events: ['page:create'],
      url: 'https://example.com/hook',
      siteId: UNKNOWN_SITE_ID
    }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(createHookCalls.length, 0)
})

test('update patches siteId, including explicitly clearing it back to null', async () => {
  existingHook.siteId = SITE_1_ID
  const res = await app.inject({
    method: 'PUT',
    url: `/${EXISTING_HOOK_ID}`,
    payload: { siteId: null }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(updateHookCalls.length, 1)
  assert.equal(updateHookCalls[0].patch.siteId, null)
})

test('update rejects a siteId that names no known site', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${EXISTING_HOOK_ID}`,
    payload: { siteId: UNKNOWN_SITE_ID }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(updateHookCalls.length, 0)
})
