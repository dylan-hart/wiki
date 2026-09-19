import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import hooksRoutes from './hooks.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'
import { EMITTED_EVENTS, HOOK_EVENTS } from '../models/hooks.ts'
import { ensureTemporal } from '../test/temporal.ts'

/**
 * `GET /events`'s Swagger `description` is hand-written and nothing ties it to `EMITTED_EVENTS`, so
 * these pin the `isEmitted` flags and refuse the stale claims the string has carried. No `wiki`:
 * the route reads only those two plain exports.
 */

test('GET /events response reflects EMITTED_EVENTS for every catalogued event', async () => {
  const app = await buildTestApp({ routes: hooksRoutes, swagger: true })
  try {
    const res = await app.inject({ method: 'GET', url: '/events' })
    assert.equal(res.statusCode, 200)
    const body = res.json() as { key: string; isEmitted: boolean }[]
    assert.deepEqual(
      body.map((e) => e.key),
      HOOK_EVENTS as unknown as string[]
    )
    for (const entry of body) {
      assert.equal(
        entry.isEmitted,
        (EMITTED_EVENTS as string[]).includes(entry.key),
        `isEmitted for ${entry.key} should match EMITTED_EVENTS`
      )
    }
    const commentEntries = body.filter((e) => e.key.startsWith('comment:'))
    assert.ok(commentEntries.length > 0)
    for (const entry of commentEntries) {
      assert.equal(entry.isEmitted, true, `${entry.key} should be reported as emitted`)
    }
  } finally {
    await closeTestApp(app)
  }
})

test('GET /events Swagger description does not repeat known-stale claims', async () => {
  const app = await buildTestApp({ routes: hooksRoutes, swagger: true })
  try {
    const spec = app.swagger() as any
    const description = spec.paths['/events'].get.description as string
    assert.doesNotMatch(description, /only the `user:\*` events/i)
    assert.doesNotMatch(description, /pages, assets and comments are not implemented/i)
    assert.doesNotMatch(description, /comments? (is|are) not (yet )?implemented/i)
  } finally {
    await closeTestApp(app)
  }
})

const SITE_1_ID = randomUUID()
const UNKNOWN_SITE_ID = randomUUID()
const EXISTING_HOOK_ID = randomUUID()

/**
 * `POST /test` runs against a real local HTTP server rather than a mocked `postJson()`: the route
 * exists for what happens over the wire (status passthrough, the auth header, a connection failure
 * reported as `ok: false` rather than thrown).
 */

let app: FastifyInstance
let server: http.Server
let serverUrl: string
let lastRequestHeaders: http.IncomingHttpHeaders | null = null
let lastRequestBody = ''
let responseStatus = 200
let createHookCalls: any[]
let updateHookCalls: any[]
let existingHook: any

before(async () => {
  await ensureTemporal()
  const wiki = {
    version: 'test',
    INSTANCE_ID: 'test-instance',
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

  app = await buildTestApp({ routes: hooksRoutes, wiki })
})

after(async () => {
  await closeTestApp(app)
  await new Promise<void>((resolve) => server.close(() => resolve()))
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

test('a url containing <, > or " is rejected with 400, matching the admin form (OpenProject #1940)', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/test',
    payload: { url: 'https://example.com/<script>' }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(lastRequestHeaders, null)
})

test('a url with a scheme that merely starts with "http" (httpfoo://) is rejected with 400 (OpenProject #1940)', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/test',
    payload: { url: 'httpfoo://x' }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(lastRequestHeaders, null)
})

test('a connection failure is reported as ok:false with statusCode 0 rather than thrown', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/test',
    // -> Nothing listens on this port
    payload: { url: 'http://127.0.0.1:1/' }
  })
  assert.equal(res.statusCode, 200)
  const json = res.json()
  assert.equal(json.ok, false)
  assert.equal(json.statusCode, 0)
  assert.ok(json.message)
})

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

test('create rejects a URL containing disallowed characters, matching the admin form', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: { name: 'My Hook', events: ['page:create'], url: 'https://example.com/<script>' }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(createHookCalls.length, 0)
})

test('create rejects a URL with a non-http(s) protocol, matching the admin form', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: { name: 'My Hook', events: ['page:create'], url: 'httpfoo://x' }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(createHookCalls.length, 0)
})
