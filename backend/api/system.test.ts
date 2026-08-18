import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import systemRoutes from './system.ts'
import { registerSchemas as registerFlagsSchema } from './schemas/flags.ts'
import { registerSchemas as registerExtensionSchema } from './schemas/extension.ts'
import { registerSchemas as registerSecuritySchema } from './schemas/security.ts'

/**
 * Route-level test for `GET /system/extensions/status`.
 *
 * The frontend gates page-import on the Pandoc extension being installed (`PageNewMenu.vue` /
 * `ImportPageDialog.vue`, per task 668), and needs to ask that without `manage:system` — the
 * permission the full `/extensions` listing requires, since that route also carries install
 * eligibility and instructions meant for admins. This route is the "lightweight … check" the task
 * called for: no route-level permissions (open to any caller, like the public site-info route), and
 * answering nothing but `{ <extensionKey>: isInstalled }` for every declared extension.
 */

let app: FastifyInstance
let getExtensions: ReturnType<typeof mock.fn>

before(async () => {
  getExtensions = mock.fn(async () => [
    { key: 'pandoc', title: 'Pandoc', isInstalled: true, isInstallable: false, isCompatible: true },
    {
      key: 'puppeteer',
      title: 'Puppeteer',
      isInstalled: false,
      isInstallable: true,
      isCompatible: true
    }
  ])

  ;(globalThis as any).WIKI = {
    models: {
      extensions: {
        getExtensions
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
    }
    done()
  })
  await registerFlagsSchema(app)
  await registerExtensionSchema(app)
  await registerSecuritySchema(app)
  await app.register(systemRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

beforeEach(() => {
  getExtensions.mock.resetCalls()
})

test('answers a key -> isInstalled map for every declared extension', async () => {
  const res = await app.inject({ method: 'GET', url: '/extensions/status' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { pandoc: true, puppeteer: false })
  assert.equal(getExtensions.mock.callCount(), 1)
})

test('answers an anonymous caller too — no route-level permission gates it', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/extensions/status',
    headers: { 'x-test-anon': 'true' }
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { pandoc: true, puppeteer: false })
})
