import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import diagramProxyRoutes from './diagramProxy.ts'
import { activeBanMemo } from '../helpers/rateLimit.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

/**
 * Route-level test for `POST /sites/:siteId/diagrams/render`.
 *
 * Driving a real Kroki/PlantUML server is `models/diagramProxy.ts`'s job — `diagramProxy.test.ts`
 * covers that with a mocked `fetch`, not this file. What belongs to the route, and what this checks:
 * the request is reachable with no session at all (no route-level `permissions` — see the handler
 * comment), the request body and resolved `:siteId` reach the model unchanged, the model's result
 * becomes the response body under its own content type with `Cache-Control: no-store`, and the rate
 * limiter is wired in front of the model.
 */

const SITE_ID = '11111111-1111-1111-1111-111111111111'

let app: FastifyInstance
let render: ReturnType<typeof mock.fn>
let consume: ReturnType<typeof mock.fn>

before(async () => {
  render = mock.fn(async () => ({ contentType: 'image/svg+xml', data: Buffer.from('<svg/>') }))
  consume = mock.fn(async () => ({ allowed: true, hits: 1, retryAfter: 0 }))

  app = await buildTestApp({
    routes: diagramProxyRoutes,
    ajv: true,
    // -> No `session` option at all: this route is reachable with no session decorated on the
    //    request whatsoever, the same as a real anonymous reader's request.
    wiki: {
      models: {
        diagramProxy: { render },
        rateLimits: { consume }
      }
    }
  })
})

after(() => closeTestApp(app))

beforeEach(() => {
  render.mock.resetCalls()
  render.mock.mockImplementation(async () => ({
    contentType: 'image/svg+xml',
    data: Buffer.from('<svg/>')
  }))
  consume.mock.resetCalls()
  consume.mock.mockImplementation(async () => ({ allowed: true, hits: 1, retryAfter: 0 }))
  // -> `limitRenders` fronts its own `CARDINAL.models.rateLimits.consume` with an in-process ban memo
  //    (`helpers/rateLimit.ts#activeBanMemo`), keyed by IP here since every request in this file is
  //    anonymous — cleared per test so a refusal in one test can't silently ban every test after it
  //    that shares the same injected IP.
  activeBanMemo.clear()
})

const BODY = { engine: 'kroki', diagramType: 'graphviz', source: 'digraph G { A -> B }' }

test('renders anonymously, with no session at all', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/diagrams/render`,
    payload: BODY
  })

  assert.equal(res.statusCode, 200)
  assert.equal(render.mock.callCount(), 1)
})

test('forwards the request body to the model unchanged, alongside the :siteId param', async () => {
  const body = { engine: 'plantuml', source: '@startuml\nA -> B\n@enduml', format: 'png' }

  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/diagrams/render`,
    payload: body
  })

  assert.equal(res.statusCode, 200)
  assert.equal(render.mock.callCount(), 1)
  assert.equal(render.mock.calls[0].arguments[0], SITE_ID)
  assert.deepEqual(render.mock.calls[0].arguments[1], body)
})

test('the body schema accepts no `server` override — it is stripped before reaching the model', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/diagrams/render`,
    payload: { ...BODY, server: 'https://attacker.example.com/steal' }
  })

  assert.equal(res.statusCode, 200)
  assert.equal((render.mock.calls[0].arguments[1] as any).server, undefined)
})

test("answers with the model's bytes under its own content type, uncached", async () => {
  render.mock.mockImplementation(async () => ({
    contentType: 'image/png',
    data: Buffer.from('PNGDATA')
  }))

  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/diagrams/render`,
    payload: BODY
  })

  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'image/png')
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.rawPayload.toString(), 'PNGDATA')
})

test("surfaces the model's own failure and status code", async () => {
  render.mock.mockImplementation(async () => {
    const err: any = new Error('The Kroki server answered 400 Bad Request for this diagram.')
    err.name = 'diagramProxyFailed'
    err.statusCode = 502
    throw err
  })

  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/diagrams/render`,
    payload: BODY
  })

  assert.equal(res.statusCode, 502)
})

test('rejects a body missing the required engine/source fields before reaching the model', async () => {
  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/diagrams/render`,
    payload: { source: 'oops' }
  })

  assert.equal(res.statusCode, 400)
  assert.equal(render.mock.callCount(), 0)
})

test('rejects a malformed :siteId before reaching the model', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/sites/not-a-uuid/diagrams/render',
    payload: BODY
  })

  assert.equal(res.statusCode, 400)
  assert.equal(render.mock.callCount(), 0)
})

test('the rate limiter runs in front of the model, and a refusal never reaches it', async () => {
  consume.mock.mockImplementation(async () => ({ allowed: false, hits: 99, retryAfter: 60 }))

  const res = await app.inject({
    method: 'POST',
    url: `/sites/${SITE_ID}/diagrams/render`,
    payload: BODY
  })

  assert.equal(res.statusCode, 429)
  assert.equal(render.mock.callCount(), 0)
})
