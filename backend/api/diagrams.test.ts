import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import diagramRoutes from './diagrams.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

/**
 * Route-level test for `POST /diagrams/render`.
 *
 * Driving a real headless browser or PlantUML server is `models/diagramRender.ts`'s job —
 * `diagramRender.test.ts` covers that without either. What belongs to the route, and what this file
 * checks, is the wiring: a request needs a session (no route-level `permissions`, since this touches
 * no page or group-wide capability — see the handler comment), the request body reaches the model
 * unchanged, and the model's result becomes the response body with the right content type.
 */

let app: FastifyInstance
let render: ReturnType<typeof mock.fn>

before(async () => {
  render = mock.fn(async () => ({ contentType: 'image/svg+xml', data: Buffer.from('<svg/>') }))

  app = await buildTestApp({
    routes: diagramRoutes,
    ajv: true,
    session: (req: any) =>
      req.headers['x-test-anon'] === 'true'
        ? { authenticated: false }
        : { authenticated: true, user: { id: 'user-1' }, permissions: [] },
    wiki: {
      models: {
        diagramRender: { render },
        rateLimits: {
          consume: mock.fn(async () => ({ allowed: true, retryAfter: 0 }))
        }
      },
      // -> Resolved and passed to the model on every render, same as the SEO hook does for its own
      //    non-site-scoped lookups — see `diagrams.ts`'s handler comment.
      sitesMappings: { '*': 'default-site-id', 'site-b.example.com': 'site-b-id' }
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
})

const BODY = { type: 'mermaid', source: 'flowchart LR\nA --> B' }

test('refuses an anonymous request without asking the model to render anything', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/render',
    headers: { 'x-test-anon': 'true' },
    payload: BODY
  })

  assert.equal(res.statusCode, 401)
  assert.equal(render.mock.callCount(), 0)
})

test('forwards the request body to the model unchanged, alongside the resolved siteId', async () => {
  const body = {
    type: 'plantuml',
    source: '@startuml\nA -> B\n@enduml',
    format: 'png'
  }

  const res = await app.inject({ method: 'POST', url: '/render', payload: body })

  assert.equal(res.statusCode, 200)
  assert.equal(render.mock.callCount(), 1)
  assert.deepEqual(render.mock.calls[0].arguments[0], body)
  assert.equal(render.mock.calls[0].arguments[1], 'default-site-id')
})

test('a server-supplied "server" field is stripped before it ever reaches the model (OpenProject #2223)', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/render',
    payload: {
      type: 'plantuml',
      source: '@startuml\nA -> B\n@enduml',
      server: 'https://x.example.com'
    }
  })

  assert.equal(res.statusCode, 200)
  assert.equal((render.mock.calls[0].arguments[0] as any).server, undefined)
})

test('resolves the site from the request hostname, not a fixed default', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/render',
    headers: { host: 'site-b.example.com' },
    payload: BODY
  })

  assert.equal(res.statusCode, 200)
  assert.equal(render.mock.calls[0].arguments[1], 'site-b-id')
})

test('falls back to the catch-all site for an unmapped hostname', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/render',
    headers: { host: 'unmapped.example.com' },
    payload: BODY
  })

  assert.equal(res.statusCode, 200)
  assert.equal(render.mock.calls[0].arguments[1], 'default-site-id')
})

test('the body schema no longer accepts a `server` override — it is stripped before reaching the model (OpenProject #2219)', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/render',
    payload: {
      type: 'plantuml',
      source: '@startuml\nA -> B\n@enduml',
      server: 'https://attacker.example.com/steal'
    }
  })

  // -> `additionalProperties: false` plus Fastify's default `removeAdditional: true` means an
  //    undeclared field like this is silently dropped from `req.body` rather than failing
  //    validation outright — the request still succeeds, but the model never sees a `server` value.
  assert.equal(res.statusCode, 200)
  assert.equal(render.mock.callCount(), 1)
  assert.deepEqual(render.mock.calls[0].arguments[0], {
    type: 'plantuml',
    source: '@startuml\nA -> B\n@enduml',
    format: 'svg'
  })
})

test("answers with the model's bytes under its own content type, uncached", async () => {
  render.mock.mockImplementation(async () => ({
    contentType: 'image/png',
    data: Buffer.from('PNGDATA')
  }))

  const res = await app.inject({ method: 'POST', url: '/render', payload: BODY })

  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'image/png')
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.rawPayload.toString(), 'PNGDATA')
})

test("surfaces the model's own failure and status code", async () => {
  render.mock.mockImplementation(async () => {
    const err: any = new Error(
      'Rendering a Mermaid diagram on the server needs the Puppeteer extension.'
    )
    err.name = 'diagramRenderPuppeteerMissing'
    err.statusCode = 503
    throw err
  })

  const res = await app.inject({ method: 'POST', url: '/render', payload: BODY })

  assert.equal(res.statusCode, 503)
})

test('rejects a body missing the required type/source fields before reaching the model', async () => {
  const res = await app.inject({ method: 'POST', url: '/render', payload: { source: 'oops' } })

  assert.equal(res.statusCode, 400)
  assert.equal(render.mock.callCount(), 0)
})
