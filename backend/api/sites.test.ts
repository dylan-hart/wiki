import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import sitesRoutes from './sites.ts'
import { SITE_PERMISSIONS } from '../helpers/siteRules.ts'
import { createSiteAdminAccessStub } from '../test/mocks.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

const WILDCARD_SITE_ID = 'wildcard-site-id'
const sitesMappings: Record<string, string> = { '*': WILDCARD_SITE_ID }
const sites: Record<string, any> = {
  [WILDCARD_SITE_ID]: {
    id: WILDCARD_SITE_ID,
    hostname: '*',
    isEnabled: true,
    config: { title: 'Wildcard Site' }
  }
}

async function getSiteByHostname({
  hostname,
  strict = false
}: {
  hostname: string
  strict?: boolean
}) {
  const siteId = strict ? sitesMappings[hostname] : sitesMappings[hostname] || sitesMappings['*']
  return siteId ? sites[siteId] : null
}

let siteBlocksResult: any[] = []
async function getSiteBlocks(_siteId: string) {
  return siteBlocksResult
}

let app: FastifyInstance

let renderingAvailable = true

const PUT_SITE_ID = '12af7860-3d28-4f2d-8a93-e9e5ec4a127b'
sites[PUT_SITE_ID] = {
  id: PUT_SITE_ID,
  hostname: 'putsite.example.com',
  isEnabled: true,
  config: { title: 'Put Site', theme: { dark: false } }
}

async function getSiteById({ id }: { id: string }) {
  return sites[id] ?? null
}

let updateSiteCalls: Array<{ id: string; patch: any }> = []
async function updateSite(id: string, patch: any) {
  if (updateSiteFailure) {
    throw updateSiteFailure
  }
  updateSiteCalls.push({ id, patch })
  return true
}

let setAssetCalls: Array<{ siteId: string; kind: string }> = []
async function setAsset(siteId: string, kind: string) {
  setAssetCalls.push({ siteId, kind })
}

let clearAssetCalls: Array<{ siteId: string; kind: string }> = []
async function clearAsset(siteId: string, kind: string) {
  clearAssetCalls.push({ siteId, kind })
}

function actorForRequest(req: any) {
  const header = req.headers['x-test-permissions']
  const permissions = typeof header === 'string' ? header.split(',').filter(Boolean) : []
  return { groupIds: [], permissions }
}

/**
 * Grants whatever `permission@siteId` pairs the `x-test-site-permissions` header lists, so a route
 * that checks the permission without threading its `siteId` through gets nothing.
 */
function checkSiteAccess(actor: { permissions: string[] }, permission: string, siteId: string) {
  if (actor.permissions.includes('manage:system')) {
    return true
  }
  return typeof currentSitePermissionHeader === 'string'
    ? currentSitePermissionHeader.split(',').filter(Boolean).includes(`${permission}@${siteId}`)
    : false
}
let currentSitePermissionHeader: string | undefined

const checkSiteAdminAccess = createSiteAdminAccessStub(actorForRequest, checkSiteAccess)

const createSiteCalls: Array<{ hostname: string; config: Record<string, any> }> = []
let hostnamesTakenByUnique: Set<string>

async function isHostnameUnique(hostname: string) {
  return !hostnamesTakenByUnique.has(hostname)
}

let createSiteFailure: Error | null = null
let updateSiteFailure: Error | null = null

async function createSite(hostname: string, config: Record<string, any>) {
  if (createSiteFailure) {
    throw createSiteFailure
  }
  createSiteCalls.push({ hostname, config })
  return { id: 'new-site-id' }
}

let enabledSiteCount = 1
async function countEnabledSites() {
  return enabledSiteCount
}

let siteCount = 2
async function countSites() {
  return siteCount
}
async function deleteSite(id: string) {
  return Boolean(sites[id])
}

const ensureSiteNavCalls: Array<{ siteId: string; locale: string }> = []
async function ensureSiteNav(siteId: string, locale: string) {
  ensureSiteNavCalls.push({ siteId, locale })
  return `nav-${siteId}-${locale}`
}

before(async () => {
  const wiki = {
    // -> Real mocks rather than `createSilentLogger`'s noops: the 500 tests assert the log LEVEL.
    logger: { error: mock.fn(), warn: mock.fn() },
    config: {
      security: { disallowOpenRedirect: true },
      docsBase: 'https://test.docs.example/docs'
    },
    models: {
      sites: {
        getSiteByHostname,
        getSiteById,
        updateSite,
        setAsset,
        clearAsset,
        isHostnameUnique,
        createSite,
        countEnabledSites,
        countSites,
        deleteSite
      },
      groups: {
        actorForRequest,
        checkSiteAccess,
        checkSiteAdminAccess
      },
      locales: {
        getLocales: async () => [{ code: 'en' }]
      },
      renderQueue: {
        isAvailable: async () => renderingAvailable
      },
      blocks: {
        getSiteBlocks
      },
      navigation: {
        ensureSiteNav
      },
      commentProviders: {
        getActiveProvider: async () => null
      },
      auditLog: {
        record: mock.fn(async () => {})
      }
    }
  }

  app = await buildTestApp({
    routes: sitesRoutes,
    wiki,
    ajv: true,
    // -> The function form captures `x-test-site-permissions` once per request: `checkSiteAccess()`
    //    takes no `req`, so the stub reads the per-test site grants off a module-level variable.
    session: (req: any) => {
      currentSitePermissionHeader = req.headers['x-test-site-permissions']
      const header = req.headers['x-test-permissions']
      const permissions = typeof header === 'string' ? header.split(',').filter(Boolean) : []
      return permissions.length > 0 ? { authenticated: true, permissions, groups: [] } : undefined
    },
    permissions: true
  })
})

after(() => closeTestApp(app))

test('strict=true does not fall back to the wildcard site', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/somehost.example.com?strict=true'
  })
  assert.equal(res.statusCode, 404)
})

test('omitting strict falls back to the wildcard site', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/somehost.example.com'
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().hostname, '*')
})

test('strict=false falls back to the wildcard site', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/somehost.example.com?strict=false'
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().hostname, '*')
})

beforeEach(() => {
  createSiteCalls.length = 0
  hostnamesTakenByUnique = new Set()
  createSiteFailure = null
  updateSiteFailure = null
  ;(globalThis as any).CARDINAL.logger.error.mock.resetCalls()
  ;(globalThis as any).CARDINAL.logger.warn.mock.resetCalls()
})

test('a schema-valid hostname creates the site', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/',
    headers: { 'x-test-permissions': 'manage:sites' },
    payload: { hostname: 'wiki.example.org', title: 'My Wiki' }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)
  assert.deepEqual(createSiteCalls, [
    { hostname: 'wiki.example.org', config: { title: 'My Wiki' } }
  ])
})

test('a hostname the schema rejects never reaches createSite', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/',
    headers: { 'x-test-permissions': 'manage:sites' },
    payload: { hostname: '<script>', title: 'My Wiki' }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(createSiteCalls.length, 0)
})

test('an empty hostname never reaches createSite', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/',
    headers: { 'x-test-permissions': 'manage:sites' },
    payload: { hostname: '', title: 'My Wiki' }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(createSiteCalls.length, 0)
})

test('the catch-all wildcard hostname is still accepted', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/',
    headers: { 'x-test-permissions': 'manage:sites' },
    payload: { hostname: '*', title: 'My Wiki' }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(createSiteCalls[0]?.hostname, '*')
})

test('an uppercase hostname is rejected by the schema and never reaches createSite', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/',
    headers: { 'x-test-permissions': 'manage:sites' },
    payload: { hostname: 'CARDINAL.example.org', title: 'My Wiki' }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(createSiteCalls.length, 0)
})

test('a hostname with a colon (port suffix) is rejected by the schema and never reaches createSite', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/',
    headers: { 'x-test-permissions': 'manage:sites' },
    payload: { hostname: 'wiki.example.org:8080', title: 'My Wiki' }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(createSiteCalls.length, 0)
})

test('a duplicate ordinary hostname is rejected with the duplicate-hostname message, never reaching createSite', async () => {
  hostnamesTakenByUnique.add('taken.example.org')
  const res = await app.inject({
    method: 'POST',
    url: '/',
    headers: { 'x-test-permissions': 'manage:sites' },
    payload: { hostname: 'taken.example.org', title: 'My Wiki' }
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().message, /duplicate hostname/i)
  assert.equal(createSiteCalls.length, 0)
})

test('a duplicate catch-all hostname is rejected with the duplicate-catch-all message, never reaching createSite', async () => {
  hostnamesTakenByUnique.add('*')
  const res = await app.inject({
    method: 'POST',
    url: '/',
    headers: { 'x-test-permissions': 'manage:sites' },
    payload: { hostname: '*', title: 'My Wiki' }
  })
  assert.equal(res.statusCode, 400)
  assert.match(res.json().message, /catch-all/i)
  assert.equal(createSiteCalls.length, 0)
})

/**
 * What tells `apiErrorHandler` apart from a handler-local catch: its generic body for a
 * `statusCode`-less throw carries `error: 'Internal Server Error'` (with a space), where
 * `reply.internalServerError()` answers `'InternalServerError'`; and it logs at `error`.
 */

test('an unexpected createSite failure reaches the shared error handler and is logged at error', async () => {
  createSiteFailure = new Error('relation "sites" does not exist at character 42')
  const res = await app.inject({
    method: 'POST',
    url: '/',
    headers: { 'x-test-permissions': 'manage:sites' },
    payload: { hostname: 'wiki.example.org', title: 'My Wiki' }
  })
  assert.equal(res.statusCode, 500)
  assert.deepEqual(res.json(), {
    ok: false,
    error: 'Internal Server Error',
    statusCode: 500,
    message: 'Internal Server error'
  })
  // -> The thrown message named a table; the client is told none of it.
  assert.equal(res.body.includes('relation'), false)
  const errorCalls = (globalThis as any).CARDINAL.logger.error.mock.calls
  assert.equal(errorCalls.length, 1)
  assert.equal(errorCalls[0].arguments[0], 'http')
  assert.match(errorCalls[0].arguments[2].error.message, /relation "sites" does not exist/)
  // -> `apiErrorHandler` spreads the request context into the same fields object as the error.
  assert.equal(errorCalls[0].arguments[2].method, 'POST')
  assert.equal(typeof errorCalls[0].arguments[2].reqId, 'string')
  assert.equal((globalThis as any).CARDINAL.logger.warn.mock.calls.length, 0)
})

test('updating a disabled site still succeeds, so it can be re-enabled', async () => {
  updateSiteCalls = []
  const DISABLED_SITE_ID = '44444444-4444-4444-8444-444444444444'
  sites[DISABLED_SITE_ID] = {
    id: DISABLED_SITE_ID,
    hostname: 'off.example.com',
    isEnabled: false,
    config: { title: 'Disabled Site' }
  }
  const res = await app.inject({
    method: 'PUT',
    url: `/${DISABLED_SITE_ID}`,
    headers: { 'x-test-permissions': 'manage:sites' },
    payload: { isEnabled: true }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)
  assert.equal(updateSiteCalls.length, 1)
  assert.equal(updateSiteCalls[0].id, DISABLED_SITE_ID)
  assert.equal(updateSiteCalls[0].patch.isEnabled, true)
})

test('an unexpected updateSite failure reaches the shared error handler and is logged at error', async () => {
  updateSiteFailure = new Error('deadlock detected')
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: { 'x-test-permissions': 'manage:sites' },
    payload: { title: 'Renamed' }
  })
  assert.equal(res.statusCode, 500)
  assert.equal(res.json().error, 'Internal Server Error')
  const errorCalls = (globalThis as any).CARDINAL.logger.error.mock.calls
  assert.equal(errorCalls.length, 1)
  assert.equal(errorCalls[0].arguments[0], 'http')
  assert.match(errorCalls[0].arguments[2].error.message, /deadlock detected/)
  assert.equal(errorCalls[0].arguments[2].method, 'PUT')
  assert.equal((globalThis as any).CARDINAL.logger.warn.mock.calls.length, 0)
})

beforeEach(() => {
  updateSiteCalls = []
})

test('manage:theme alone may save a theme-only patch', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: { 'x-test-permissions': 'manage:theme' },
    payload: { theme: { dark: true } }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)
  assert.equal(updateSiteCalls.length, 1)
  assert.deepEqual(updateSiteCalls[0].patch.config.theme, { dark: true })
})

test('manage:theme alone may not save a patch that also touches another key', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: { 'x-test-permissions': 'manage:theme' },
    payload: { theme: { dark: true }, title: 'Renamed' }
  })
  assert.equal(res.statusCode, 403)
  assert.equal(updateSiteCalls.length, 0)
})

test('manage:theme alone may not save a patch that touches no theme key at all', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: { 'x-test-permissions': 'manage:theme' },
    payload: { title: 'Renamed' }
  })
  assert.equal(res.statusCode, 403)
  assert.equal(updateSiteCalls.length, 0)
})

test('a caller with neither manage:sites nor manage:theme nor site:theme is refused', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: { 'x-test-permissions': 'manage:navigation' },
    payload: { theme: { dark: true } }
  })
  assert.equal(res.statusCode, 403)
  assert.equal(updateSiteCalls.length, 0)
})

test('manage:sites may still save a patch touching fields beyond theme', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: { 'x-test-permissions': 'manage:sites' },
    payload: { theme: { dark: true }, title: 'Renamed' }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(updateSiteCalls.length, 1)
  assert.equal(updateSiteCalls[0].patch.config.title, 'Renamed')
})

test('a features patch does not synthesize a legacy ratings alias key', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: { 'x-test-permissions': 'manage:sites' },
    payload: { features: { comments: true } }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(updateSiteCalls.length, 1)
  assert.deepEqual(updateSiteCalls[0].patch.config.features, { comments: true })
})

test('a successful update records a site.settingsUpdated audit log entry', async () => {
  ;(globalThis as any).CARDINAL.models.auditLog.record.mock.resetCalls()
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: { 'x-test-permissions': 'manage:sites' },
    payload: { title: 'Renamed Again' }
  })
  assert.equal(res.statusCode, 200)
  const calls = (globalThis as any).CARDINAL.models.auditLog.record.mock.calls
  assert.equal(calls.length, 1)
  const call = calls[0].arguments[0]
  assert.equal(call.event, 'site.settingsUpdated')
  assert.equal(call.targetType, 'site')
  assert.equal(call.targetId, PUT_SITE_ID)
  assert.equal(call.targetLabel, 'Renamed Again')
  assert.deepEqual(call.detail, { changedFields: ['title'] })
})

test('site:general on this site may save general-surface fields', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: {
      'x-test-permissions': '',
      'x-test-site-permissions': `site:general@${PUT_SITE_ID}`
    },
    payload: { title: 'Renamed', discoverable: true }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(updateSiteCalls.length, 1)
  assert.equal(updateSiteCalls[0].patch.config.title, 'Renamed')
})

test('site:general on this site may save allowedUrlSchemes (task #2457)', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: {
      'x-test-permissions': '',
      'x-test-site-permissions': `site:general@${PUT_SITE_ID}`
    },
    payload: { allowedUrlSchemes: ['discord', 'steam'] }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(updateSiteCalls.length, 1)
  assert.deepEqual(updateSiteCalls[0].patch.config.allowedUrlSchemes, ['discord', 'steam'])
})

/**
 * The schema enforces only a well-formed, lowercase RFC 3986 scheme name — deliberately NOT a
 * `javascript`/`vbscript`/`data` denylist: those are blocked where they could take effect
 * (`mergeAllowedSchemes()`), whatever is configured, rather than by a bypassable save-time check.
 */
test('an uppercase allowedUrlSchemes entry is rejected by the schema and never reaches updateSite', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: {
      'x-test-permissions': '',
      'x-test-site-permissions': `site:general@${PUT_SITE_ID}`
    },
    payload: { allowedUrlSchemes: ['Discord'] }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(updateSiteCalls.length, 0)
})

test('an allowedUrlSchemes entry with an invalid character is rejected by the schema and never reaches updateSite', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: {
      'x-test-permissions': '',
      'x-test-site-permissions': `site:general@${PUT_SITE_ID}`
    },
    payload: { allowedUrlSchemes: ['dis cord'] }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(updateSiteCalls.length, 0)
})

test('site:general on this site may save security.embedAllowedOrigins (task #3274)', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: {
      'x-test-permissions': '',
      'x-test-site-permissions': `site:general@${PUT_SITE_ID}`
    },
    payload: { security: { embedAllowedOrigins: ['https://intranet.example.com'] } }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(updateSiteCalls.length, 1)
  assert.deepEqual(updateSiteCalls[0].patch.config.security, {
    embedAllowedOrigins: ['https://intranet.example.com']
  })
})

/**
 * The schema enforces a bare origin (`scheme://host[:port]`, lowercase, no path/query/fragment):
 * the array is emitted verbatim as CSP `frame-ancestors` source-list tokens.
 */
test('a security.embedAllowedOrigins entry with a path is rejected by the schema and never reaches updateSite', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: {
      'x-test-permissions': '',
      'x-test-site-permissions': `site:general@${PUT_SITE_ID}`
    },
    payload: { security: { embedAllowedOrigins: ['https://intranet.example.com/embed'] } }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(updateSiteCalls.length, 0)
})

test('an uppercase security.embedAllowedOrigins entry is rejected by the schema and never reaches updateSite', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: {
      'x-test-permissions': '',
      'x-test-site-permissions': `site:general@${PUT_SITE_ID}`
    },
    payload: { security: { embedAllowedOrigins: ['https://Intranet.example.com'] } }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(updateSiteCalls.length, 0)
})

const BANNER = { isEnabled: true, title: 'Maintenance', content: 'Down tonight at 22:00.' }

test('site:general on this site may save the banner', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: {
      'x-test-permissions': '',
      'x-test-site-permissions': `site:general@${PUT_SITE_ID}`
    },
    payload: { banner: BANNER }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(updateSiteCalls.length, 1)
  assert.deepEqual(updateSiteCalls[0].patch.config.banner, BANNER)
})

test('a partial banner patch reaches updateSite untouched so the model can deep-merge it', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: {
      'x-test-permissions': '',
      'x-test-site-permissions': `site:general@${PUT_SITE_ID}`
    },
    payload: { banner: { isEnabled: false } }
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(updateSiteCalls[0].patch.config.banner, { isEnabled: false })
})

test('manage:sites may save the banner', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: { 'x-test-permissions': 'manage:sites' },
    payload: { banner: BANNER }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(updateSiteCalls.length, 1)
})

test('site:theme alone may not save the banner', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: {
      'x-test-permissions': '',
      'x-test-site-permissions': `site:theme@${PUT_SITE_ID}`
    },
    payload: { banner: BANNER }
  })
  assert.equal(res.statusCode, 403)
  assert.equal(updateSiteCalls.length, 0)
})

test('manage:theme alone may not save the banner', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: { 'x-test-permissions': 'manage:theme' },
    payload: { banner: BANNER }
  })
  assert.equal(res.statusCode, 403)
  assert.equal(updateSiteCalls.length, 0)
})

for (const [field, limit] of [
  ['title', 255],
  ['content', 2000]
] as const) {
  test(`a banner ${field} over ${limit} characters is rejected and never reaches updateSite`, async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/${PUT_SITE_ID}`,
      headers: { 'x-test-permissions': 'manage:sites' },
      payload: { banner: { [field]: 'x'.repeat(limit + 1) } }
    })
    assert.equal(res.statusCode, 400)
    assert.equal(updateSiteCalls.length, 0)
  })

  test(`a banner ${field} of exactly ${limit} characters is accepted`, async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/${PUT_SITE_ID}`,
      headers: { 'x-test-permissions': 'manage:sites' },
      payload: { banner: { [field]: 'x'.repeat(limit) } }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(updateSiteCalls.length, 1)
  })
}

test('the public site payload carries the banner', async () => {
  const original = sites[WILDCARD_SITE_ID].config
  sites[WILDCARD_SITE_ID].config = { ...original, banner: BANNER }
  try {
    const res = await app.inject({ method: 'GET', url: '/somehost.example.com' })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json().banner, BANNER)
  } finally {
    sites[WILDCARD_SITE_ID].config = original
  }
})

test('site:general on this site may not also save the theme surface', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: {
      'x-test-permissions': '',
      'x-test-site-permissions': `site:general@${PUT_SITE_ID}`
    },
    payload: { title: 'Renamed', theme: { dark: true } }
  })
  assert.equal(res.statusCode, 403)
  assert.equal(updateSiteCalls.length, 0)
})

test('site:theme on this site may save a theme-only patch, same as manage:theme', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: {
      'x-test-permissions': '',
      'x-test-site-permissions': `site:theme@${PUT_SITE_ID}`
    },
    payload: { theme: { dark: true } }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(updateSiteCalls.length, 1)
})

test('site:login on this site may save auth and authStrategies', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: {
      'x-test-permissions': '',
      'x-test-site-permissions': `site:login@${PUT_SITE_ID}`
    },
    payload: {
      auth: { autoLogin: true },
      authStrategies: [{ id: '4b3e6f2a-6b3a-4e34-8c8e-2e9b6a9c6f0a', order: 0, isVisible: true }]
    }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(updateSiteCalls.length, 1)
})

/**
 * `site:login` is a delegated, non-administrator permission: an unvalidated redirect would let its
 * holder plant a `javascript:` URL the login flow then sends every reader through. Covered from
 * both permission paths below.
 */
test('rejects a javascript: auth.loginRedirect with 400, and never reaches updateSite', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: { 'x-test-permissions': 'manage:sites' },
    payload: { auth: { loginRedirect: 'javascript:alert(1)' } }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(updateSiteCalls.length, 0)
})

test('site:login on this site may NOT save a javascript: loginRedirect', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: {
      'x-test-permissions': '',
      'x-test-site-permissions': `site:login@${PUT_SITE_ID}`
    },
    payload: { auth: { loginRedirect: 'javascript:alert(1)' } }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(updateSiteCalls.length, 0)
})

test('rejects a scheme-relative //host auth.welcomeRedirect with 400', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: { 'x-test-permissions': 'manage:sites' },
    payload: { auth: { welcomeRedirect: '//attacker.example' } }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(updateSiteCalls.length, 0)
})

test('site:login on this site may NOT save a protocol-relative //host welcomeRedirect', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: {
      'x-test-permissions': '',
      'x-test-site-permissions': `site:login@${PUT_SITE_ID}`
    },
    payload: { auth: { welcomeRedirect: '//evil.example' } }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(updateSiteCalls.length, 0)
})

test('accepts a rooted path for auth.logoutRedirect', async () => {
  updateSiteCalls = []
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: { 'x-test-permissions': 'manage:sites' },
    payload: { auth: { logoutRedirect: '/' } }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(updateSiteCalls[0].patch.config.auth.logoutRedirect, '/')
})

test('accepts a complete https:// URL for auth.logoutRedirect once disallowOpenRedirect is off', async () => {
  const original = CARDINAL.config.security.disallowOpenRedirect
  CARDINAL.config.security.disallowOpenRedirect = false
  try {
    updateSiteCalls = []
    const res = await app.inject({
      method: 'PUT',
      url: `/${PUT_SITE_ID}`,
      headers: { 'x-test-permissions': 'manage:sites' },
      payload: { auth: { logoutRedirect: 'https://example.com/goodbye' } }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(updateSiteCalls[0].patch.config.auth.logoutRedirect, 'https://example.com/goodbye')
  } finally {
    CARDINAL.config.security.disallowOpenRedirect = original
  }
})

test('site:login on this site may save a rooted-path logoutRedirect', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: {
      'x-test-permissions': '',
      'x-test-site-permissions': `site:login@${PUT_SITE_ID}`
    },
    payload: { auth: { logoutRedirect: '/goodbye' } }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(updateSiteCalls.length, 1)
  assert.equal(updateSiteCalls[0].patch.config.auth.logoutRedirect, '/goodbye')
})

test('site:locale on this site may save locales', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: {
      'x-test-permissions': '',
      'x-test-site-permissions': `site:locale@${PUT_SITE_ID}`
    },
    payload: { locales: { primary: 'en', active: ['en'], forcePrefix: false, showMenu: true } }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(updateSiteCalls.length, 1)
})

test('site:editors on this site may save editors', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: {
      'x-test-permissions': '',
      'x-test-site-permissions': `site:editors@${PUT_SITE_ID}`
    },
    payload: { editors: { markdown: { isActive: true } } }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(updateSiteCalls.length, 1)
})

test('site:editors on a DIFFERENT site does not grant access to this site', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: {
      'x-test-permissions': '',
      'x-test-site-permissions': 'site:editors@some-other-site-id'
    },
    payload: { editors: { markdown: { isActive: true } } }
  })
  assert.equal(res.statusCode, 403)
  assert.equal(updateSiteCalls.length, 0)
})

test('site:general does not cover isEnabled, which stays manage:sites-only', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: {
      'x-test-permissions': '',
      'x-test-site-permissions': `site:general@${PUT_SITE_ID}`
    },
    payload: { isEnabled: false }
  })
  assert.equal(res.statusCode, 403)
  assert.equal(updateSiteCalls.length, 0)
})

test('site:general does not grant DELETE /:siteId, which stays manage:sites-only', async () => {
  const res = await app.inject({
    method: 'DELETE',
    url: `/${PUT_SITE_ID}`,
    headers: {
      // -> A held but unrelated global permission, so the refusal comes from the route-level hook's
      //    "not one of the route's permissions" 403 branch rather than its 401 branch.
      'x-test-permissions': 'manage:navigation',
      'x-test-site-permissions': `site:general@${PUT_SITE_ID}`
    }
  })
  assert.equal(res.statusCode, 403)
})

test('DELETE /:siteId answers 404, not 400, for an unknown siteId', async () => {
  const res = await app.inject({
    method: 'DELETE',
    url: '/00000000-0000-0000-0000-000000000000',
    headers: {
      'x-test-permissions': 'manage:sites'
    }
  })
  assert.equal(res.statusCode, 404)
})

beforeEach(() => {
  setAssetCalls = []
  clearAssetCalls = []
})

// -> A valid PNG, so the route's byte-sniffing validation (after the permission check) passes too.
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

test('site:general on this site may upload a logo', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}/images/logo`,
    headers: {
      'x-test-permissions': '',
      'x-test-site-permissions': `site:general@${PUT_SITE_ID}`,
      'content-type': 'image/png'
    },
    payload: ONE_PIXEL_PNG
  })
  assert.equal(res.statusCode, 200)
  assert.equal(setAssetCalls.length, 1)
  assert.equal(setAssetCalls[0].kind, 'logo')
})

test('site:general on this site may NOT upload a loginBg', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}/images/loginBg`,
    headers: {
      'x-test-permissions': '',
      'x-test-site-permissions': `site:general@${PUT_SITE_ID}`,
      'content-type': 'image/png'
    },
    payload: ONE_PIXEL_PNG
  })
  assert.equal(res.statusCode, 403)
  assert.equal(setAssetCalls.length, 0)
})

test('site:login on this site may upload a loginBg', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}/images/loginBg`,
    headers: {
      'x-test-permissions': '',
      'x-test-site-permissions': `site:login@${PUT_SITE_ID}`,
      'content-type': 'image/png'
    },
    payload: ONE_PIXEL_PNG
  })
  assert.equal(res.statusCode, 200)
  assert.equal(setAssetCalls.length, 1)
  assert.equal(setAssetCalls[0].kind, 'loginBg')
})

test('site:general on this site may clear a favicon', async () => {
  const res = await app.inject({
    method: 'DELETE',
    url: `/${PUT_SITE_ID}/images/favicon`,
    headers: {
      'x-test-permissions': '',
      'x-test-site-permissions': `site:general@${PUT_SITE_ID}`
    }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(clearAssetCalls.length, 1)
})

test('site:general on this site may NOT clear a loginBg', async () => {
  const res = await app.inject({
    method: 'DELETE',
    url: `/${PUT_SITE_ID}/images/loginBg`,
    headers: {
      'x-test-permissions': '',
      'x-test-site-permissions': `site:general@${PUT_SITE_ID}`
    }
  })
  assert.equal(res.statusCode, 403)
  assert.equal(clearAssetCalls.length, 0)
})

const OTHER_SITE_ID = '9f2c9a3e-3b8e-4a4c-9a3b-3c9a3e3b8e4a'

test('userPermissions returns exactly the site: permissions granted for THIS site', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/${PUT_SITE_ID}/userPermissions`,
    headers: {
      'x-test-permissions': '',
      'x-test-site-permissions': `site:general@${PUT_SITE_ID},site:theme@${PUT_SITE_ID}`
    }
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(new Set(res.json()), new Set(['site:general', 'site:theme']))
})

test('userPermissions does not leak a permission granted on a DIFFERENT site', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/${PUT_SITE_ID}/userPermissions`,
    headers: {
      'x-test-permissions': '',
      'x-test-site-permissions': `site:theme@${OTHER_SITE_ID}`
    }
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), [])
})

test('userPermissions returns every site: permission for manage:system', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/${PUT_SITE_ID}/userPermissions`,
    headers: {
      'x-test-permissions': 'manage:system'
    }
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(new Set(res.json()), new Set(SITE_PERMISSIONS))
})

/**
 * Folding `manage:sites` in would claim `site:*` grants it does not confer (`site:navigation`,
 * say). The frontend combines this list with the global permissions itself, per surface.
 */
test('userPermissions does NOT fold in manage:sites', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/${PUT_SITE_ID}/userPermissions`,
    headers: {
      'x-test-permissions': 'manage:sites'
    }
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), [])
})

test('userPermissions returns an empty array for an anonymous caller', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/${PUT_SITE_ID}/userPermissions`
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), [])
})

test('pdfExportAvailable reflects the rendering model when the extension is installed', async () => {
  renderingAvailable = true
  const res = await app.inject({
    method: 'GET',
    url: '/somehost.example.com'
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().pdfExportAvailable, true)
})

test('pdfExportAvailable reflects the rendering model when the extension is not installed', async () => {
  renderingAvailable = false
  const res = await app.inject({
    method: 'GET',
    url: '/somehost.example.com'
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().pdfExportAvailable, false)
})

/**
 * The setting lives at `config.search.config.semanticEnabled`, the path `api/search.ts`'s PATCH
 * saves to. `CARDINAL.capabilities` is mutated on the installed global per test, since
 * `buildTestApp` installs the `CARDINAL` stub once for the whole file.
 */
test('features.semanticSearch is true only when the capability and the correctly-nested setting are both on', async () => {
  ;(globalThis as any).CARDINAL.capabilities = { semanticSearch: true }
  sites[WILDCARD_SITE_ID].config.search = { config: { semanticEnabled: true } }
  const res = await app.inject({ method: 'GET', url: '/somehost.example.com' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().features.semanticSearch, true)
  delete sites[WILDCARD_SITE_ID].config.search
})

test('features.semanticSearch stays false when the setting is only present at the old, wrong nesting level', async () => {
  ;(globalThis as any).CARDINAL.capabilities = { semanticSearch: true }
  sites[WILDCARD_SITE_ID].config.search = { semanticEnabled: true }
  const res = await app.inject({ method: 'GET', url: '/somehost.example.com' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().features.semanticSearch, false)
  delete sites[WILDCARD_SITE_ID].config.search
})

test('features.semanticSearch stays false when the capability is off, even with the setting correctly enabled', async () => {
  ;(globalThis as any).CARDINAL.capabilities = { semanticSearch: false }
  sites[WILDCARD_SITE_ID].config.search = { config: { semanticEnabled: true } }
  const res = await app.inject({ method: 'GET', url: '/somehost.example.com' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().features.semanticSearch, false)
  delete sites[WILDCARD_SITE_ID].config.search
})

test('docsBase reflects CARDINAL.config.docsBase', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/somehost.example.com'
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().docsBase, 'https://test.docs.example/docs')
})

test('navigationId resolves via ensureSiteNav for this site and its default locale', async () => {
  ensureSiteNavCalls.length = 0
  const res = await app.inject({
    method: 'GET',
    url: '/somehost.example.com'
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().navigationId, `nav-${WILDCARD_SITE_ID}-en`)
  assert.deepEqual(ensureSiteNavCalls, [{ siteId: WILDCARD_SITE_ID, locale: 'en' }])
})

test('disabling the only enabled site is refused with a 409 and never reaches updateSite', async () => {
  updateSiteCalls.length = 0
  enabledSiteCount = 1
  const id = '55555555-5555-4555-8555-555555555555'
  sites[id] = {
    id,
    hostname: 'only-enabled.example.com',
    isEnabled: true,
    config: { title: 'Only Enabled Site' }
  }
  const res = await app.inject({
    method: 'PUT',
    url: `/${id}`,
    headers: { 'x-test-permissions': 'manage:sites' },
    payload: { isEnabled: false }
  })
  assert.equal(res.statusCode, 409)
  assert.match(res.json().message, /last enabled site/i)
  assert.equal(updateSiteCalls.length, 0)
})

test('disabling a site is allowed when another site would remain enabled', async () => {
  updateSiteCalls.length = 0
  enabledSiteCount = 2
  const id = '66666666-6666-4666-8666-666666666666'
  sites[id] = {
    id,
    hostname: 'one-of-many.example.com',
    isEnabled: true,
    config: { title: 'One Of Many' }
  }
  const res = await app.inject({
    method: 'PUT',
    url: `/${id}`,
    headers: { 'x-test-permissions': 'manage:sites' },
    payload: { isEnabled: false }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)
  assert.equal(updateSiteCalls.length, 1)
  assert.equal(updateSiteCalls[0].patch.isEnabled, false)
})

test('disabling an already-disabled site does not re-check the enabled count (no-op patch, not a conflict)', async () => {
  updateSiteCalls.length = 0
  enabledSiteCount = 1
  const id = '77777777-7777-4777-8777-777777777777'
  sites[id] = {
    id,
    hostname: 'already-off.example.com',
    isEnabled: false,
    config: { title: 'Already Off' }
  }
  const res = await app.inject({
    method: 'PUT',
    url: `/${id}`,
    headers: { 'x-test-permissions': 'manage:sites' },
    payload: { isEnabled: false }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(updateSiteCalls.length, 1)
})

test('blocksConfig includes an enabled block that declares config fields, keyed by tag', async () => {
  siteBlocksResult = [
    {
      block: 'map',
      isEnabled: true,
      configFields: [{ name: 'tileServerUrl', type: 'string' }],
      config: { tileServerUrl: 'https://example.test/{z}/{x}/{y}.png' }
    }
  ]
  const res = await app.inject({ method: 'GET', url: '/somehost.example.com' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().blocksConfig, {
    map: { tileServerUrl: 'https://example.test/{z}/{x}/{y}.png' }
  })
})

test('blocksConfig omits a disabled block even if it declares config fields', async () => {
  siteBlocksResult = [
    {
      block: 'map',
      isEnabled: false,
      configFields: [{ name: 'tileServerUrl', type: 'string' }],
      config: { tileServerUrl: 'https://example.test/{z}/{x}/{y}.png' }
    }
  ]
  const res = await app.inject({ method: 'GET', url: '/somehost.example.com' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().blocksConfig, {})
})

test('blocksConfig omits an enabled block that declares no config fields', async () => {
  siteBlocksResult = [{ block: 'index', isEnabled: true, configFields: [], config: {} }]
  const res = await app.inject({ method: 'GET', url: '/somehost.example.com' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().blocksConfig, {})
})

test('blocksIndex includes an enabled block, custom or built-in, keyed by tag', async () => {
  siteBlocksResult = [
    {
      block: 'map',
      isEnabled: true,
      isCustom: false,
      id: 'builtin-map-id',
      configFields: [],
      config: {}
    },
    {
      block: 'widget',
      isEnabled: true,
      isCustom: true,
      id: 'custom-widget-id',
      configFields: [],
      config: {}
    }
  ]
  const res = await app.inject({ method: 'GET', url: '/somehost.example.com' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().blocksIndex, {
    map: { id: 'builtin-map-id', isCustom: false },
    widget: { id: 'custom-widget-id', isCustom: true }
  })
})

test('blocksIndex omits a disabled block', async () => {
  siteBlocksResult = [
    {
      block: 'map',
      isEnabled: false,
      isCustom: false,
      id: 'builtin-map-id',
      configFields: [],
      config: {}
    }
  ]
  const res = await app.inject({ method: 'GET', url: '/somehost.example.com' })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().blocksIndex, {})
})
