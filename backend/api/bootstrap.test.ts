import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import bootstrapRoutes from './bootstrap.ts'
import { registerSchemas as registerSiteSchema } from './schemas/site.ts'
import { registerSchemas as registerFlagsSchema } from './schemas/flags.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'

/**
 * Task 500: `GET /_api/bootstrap` reuses `sites.ts`'s `buildSitePayload`, so the `pdfExportAvailable`
 * flag it surfaces on `sites/:siteIdorHostname` (see `sites.test.ts`) also reaches the app on first
 * load — the other payload the task calls out, since `App.vue` reads the site from here rather than
 * making a second call to `sites/:siteIdorHostname` on every boot.
 */

const SITE_ID = 'bootstrap-site-id'
const site = {
  id: SITE_ID,
  hostname: 'wiki.example.com',
  isEnabled: true,
  config: { title: 'Bootstrap Site' }
}

let renderingAvailable: boolean

let app: FastifyInstance

before(async () => {
  ;(globalThis as any).WIKI = {
    models: {
      sites: {
        getSiteByHostname: async ({ hostname }: { hostname: string }) =>
          hostname === site.hostname ? site : null
      },
      flags: {
        getFlags: () => ({ experimental: false, authDebug: false, sqlLog: false })
      },
      rendering: {
        isAvailable: async () => renderingAvailable
      }
    }
  }

  app = fastify({
    ajv: {
      plugins: [[ajvFormats.default, {}] as any],
      onCreate: (ajv: any) => {
        ajv.addFormat('hexcolor', (data: unknown) => {
          return (
            typeof data === 'string' &&
            /^#(?:[a-fA-F0-9]{3,4}|[a-fA-F0-9]{6}|[a-fA-F0-9]{8})$/.test(data)
          )
        })
      }
    }
  })
  await app.register(fastifySensible)
  await registerErrorSchema(app)
  await registerSiteSchema(app)
  await registerFlagsSchema(app)
  await app.register(bootstrapRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

test('bootstrap surfaces pdfExportAvailable: true on site when rendering is available', async () => {
  renderingAvailable = true
  const res = await app.inject({
    method: 'GET',
    url: `/?hostname=${site.hostname}`
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().site.pdfExportAvailable, true)
})

test('bootstrap surfaces pdfExportAvailable: false on site when rendering is unavailable', async () => {
  renderingAvailable = false
  const res = await app.inject({
    method: 'GET',
    url: `/?hostname=${site.hostname}`
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().site.pdfExportAvailable, false)
})
