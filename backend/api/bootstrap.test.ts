import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import bootstrapRoutes from './bootstrap.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

describe('pdfExportAvailable exposure (task 500)', () => {
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
          renderQueue: {
            isAvailable: async () => renderingAvailable
          },
          blocks: {
            getSiteBlocks: async () => []
          },
          navigation: {
            ensureSiteNav: async () => 'nav-id'
          },
          commentProviders: {
            getActiveProvider: async () => null
          }
        },
        config: {
          docsBase: 'https://test.docs.example/docs'
        }
      }
    })
  })

  after(() => closeTestApp(app))

  test('bootstrap surfaces docsBase from CARDINAL.config on site', async () => {
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

  test('bootstrap surfaces navigationId on site', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/?hostname=${site.hostname}`
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().site.navigationId, 'nav-id')
  })
})

describe('navigationId exposure (OpenProject #2526/#2527)', () => {
  const SITE_ID = 'bootstrap-nav-site-id'
  const site = {
    id: SITE_ID,
    hostname: 'nav.example.com',
    isEnabled: true,
    config: { title: 'Nav Bootstrap Site' }
  }

  let app: FastifyInstance
  let ensureSiteNavCalls: Array<{ siteId: string; locale: string }>

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
          renderQueue: {
            isAvailable: async () => false
          },
          blocks: {
            getSiteBlocks: async () => []
          },
          navigation: {
            ensureSiteNav: async (siteId: string, locale: string) => {
              ensureSiteNavCalls.push({ siteId, locale })
              return 'default-nav-id'
            }
          },
          commentProviders: {
            getActiveProvider: async () => null
          }
        },
        config: {
          docsBase: 'https://test.docs.example/docs'
        }
      }
    })
  })

  after(() => closeTestApp(app))

  test('bootstrap surfaces the site-wide default navigationId, resolved via ensureSiteNav', async () => {
    ensureSiteNavCalls = []
    const res = await app.inject({
      method: 'GET',
      url: `/?hostname=${site.hostname}`
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().site.navigationId, 'default-nav-id')
    assert.deepEqual(ensureSiteNavCalls, [{ siteId: SITE_ID, locale: 'en' }])
  })
})

describe('isEnabled guard (task 699)', () => {
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
          blocks: { getSiteBlocks: async () => [] },
          navigation: { ensureSiteNav: async () => 'nav-id' },
          commentProviders: { getActiveProvider: async () => null }
        },
        config: {
          docsBase: 'https://test.docs.example/docs'
        }
      }
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    delete (globalThis as any).CARDINAL.session
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
