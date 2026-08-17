import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import bootstrapRoutes from './bootstrap.ts'
import { registerSchemas as registerSiteSchema } from './schemas/site.ts'
import { registerSchemas as registerFlagsSchema } from './schemas/flags.ts'

/**
 * Regression test for task 699: `GET /_api/bootstrap` is the highest-value isEnabled check in the
 * feature, because `App.vue`'s `loadBootstrap` is the one call every page of the SPA boots against —
 * unlike the page/shell hook in `index.ts` (task 695), which only ever sees a page navigation, this
 * endpoint resolves its own site independently and previously handed back a disabled site's full
 * config to anybody who asked.
 *
 * Contract asserted here (documented in `helpers/common.ts`'s `guardSiteEnabled`): no site behind the
 * hostname is a 404 (unchanged, pre-existing behavior), a site that resolved but has
 * `isEnabled === false` is a distinguishable 403.
 */

const ENABLED_SITE_ID = 'enabled-site-id'
const DISABLED_SITE_ID = 'disabled-site-id'

const sites: Record<string, any> = {
  [ENABLED_SITE_ID]: {
    id: ENABLED_SITE_ID,
    hostname: 'wiki.example.com',
    isEnabled: true,
    config: { title: 'Enabled Site' }
  },
  [DISABLED_SITE_ID]: {
    id: DISABLED_SITE_ID,
    hostname: 'off.example.com',
    isEnabled: false,
    config: { title: 'Disabled Site' }
  }
}

const sitesMappings: Record<string, string> = {
  'wiki.example.com': ENABLED_SITE_ID,
  'off.example.com': DISABLED_SITE_ID
}

async function getSiteByHostname({ hostname }: { hostname: string }) {
  const siteId = sitesMappings[hostname]
  return siteId ? sites[siteId] : null
}

let app: FastifyInstance

before(async () => {
  ;(globalThis as any).WIKI = {
    models: {
      sites: { getSiteByHostname },
      flags: { getFlags: () => ({ experimental: false }) }
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
  await registerSiteSchema(app)
  await registerFlagsSchema(app)
  await app.register(bootstrapRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

beforeEach(() => {
  delete (globalThis as any).WIKI.session
})

test('answers 404 for a hostname with no site behind it', async () => {
  const res = await app.inject({ method: 'GET', url: '/?hostname=nowhere.example.com' })
  assert.equal(res.statusCode, 404)
})

test('answers the site, flags and session for an enabled site', async () => {
  const res = await app.inject({ method: 'GET', url: '/?hostname=wiki.example.com' })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.site.id, ENABLED_SITE_ID)
  assert.equal(body.site.isEnabled, true)
  assert.equal(body.user.authenticated, false)
})

test('answers 403, distinguishable from 404, for a resolved-but-disabled site', async () => {
  const res = await app.inject({ method: 'GET', url: '/?hostname=off.example.com' })
  assert.equal(res.statusCode, 403)
  assert.notEqual(res.statusCode, 404)
  assert.match(res.json().message, /disabled/i)
})
