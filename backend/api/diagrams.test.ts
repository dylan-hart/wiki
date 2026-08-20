import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import diagramRoutes from './diagrams.ts'
import { registerSchemas as registerDiagramSchema } from './schemas/diagram.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'

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

  ;(globalThis as any).WIKI = {
    models: {
      diagramRender: { render },
      rateLimits: {
        consume: mock.fn(async () => ({ allowed: true, retryAfter: 0 }))
      }
    }
  }

  app = fastify({
    ajv: {
      plugins: [[ajvFormats.default, {}] as any]
    }
  })
  await app.register(fastifySensible)
  app.addHook('onRequest', (req, _reply, done) => {
    if (req.headers['x-test-anon'] !== 'true') {
      ;(req as any).session = { authenticated: true, user: { id: 'user-1' }, permissions: [] }
    } else {
      ;(req as any).session = { authenticated: false }
    }
    done()
  })
  await registerErrorSchema(app)
  await registerDiagramSchema(app)
  await app.register(diagramRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

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

test('forwards the request body to the model unchanged', async () => {
  const body = {
    type: 'plantuml',
    source: '@startuml\nA -> B\n@enduml',
    format: 'png',
    server: 'https://x.example.com'
  }

  const res = await app.inject({ method: 'POST', url: '/render', payload: body })

  assert.equal(res.statusCode, 200)
  assert.equal(render.mock.callCount(), 1)
  assert.deepEqual(render.mock.calls[0].arguments[0], body)
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
