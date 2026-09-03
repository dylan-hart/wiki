import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import bootstrapRoutes from './bootstrap.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

describe('pdfExportAvailable exposure (task 500)', () => {
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
    app = await buildTestApp({
      routes: bootstrapRoutes,
      ajv: true,
      wiki: {
        models: {
          sites: {
            getSiteByHostname: async ({ hostname }: { hostname: string }) =>
              hostname === site.hostname ? site : null
          },
          flags: {
            getFlags: () => ({ experimental: false, authDebug: false, sqlLog: false })
          },
          // -> `buildSitePayload` reads availability off `renderQueue`, not `rendering` (the
          //    two were split apart in `models/rendering.ts`'s own refactor).
          renderQueue: {
            isAvailable: async () => renderingAvailable
          },
          blocks: {
            getSiteBlocks: async () => []
          }
        },
        config: {
          docsBase: 'https://test.docs.example/docs'
        }
      }
    })
  })

  after(() => closeTestApp(app))

  test('bootstrap surfaces docsBase from WIKI.config on site', async () => {
    renderingAvailable = true
    const res = await app.inject({
      method: 'GET',
      url: `/?hostname=${site.hostname}`
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().site.docsBase, 'https://test.docs.example/docs')
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
})

describe('isEnabled guard (task 699)', () => {
  /**
   * Regression test for task 699: `GET /_api/bootstrap` is the highest-value isEnabled check in the
   * feature, because `App.vue`'s `loadBootstrap` is the one call every page of the SPA boots against —
   * unlike the page/shell hook in `index.ts` (task 695), which only ever sees a page navigation, this
   * endpoint resolves its own site independently and previously handed back a disabled site's full
   * config to anybody who asked.
   *
   * Contract asserted here (documented in `helpers/siteResolution.ts`'s `guardSiteEnabled`): no site behind the
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
    app = await buildTestApp({
      routes: bootstrapRoutes,
      ajv: true,
      wiki: {
        models: {
          sites: { getSiteByHostname },
          flags: { getFlags: () => ({ experimental: false }) },
          renderQueue: { isAvailable: async () => false },
          blocks: { getSiteBlocks: async () => [] }
        },
        config: {
          docsBase: 'https://test.docs.example/docs'
        }
      }
    })
  })

  after(() => closeTestApp(app))

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
})
