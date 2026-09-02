import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import sitesRoutes from './sites.ts'
import { SITE_PERMISSIONS } from '../helpers/siteRules.ts'
import { createSiteAdminAccessStub } from '../test/mocks.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

/**
 * Regression test for `GET /_api/sites/:siteIdorHostname`'s `strict` querystring flag: the handler
 * read `(req as any).querystring?.strict`, a property Fastify never populates (the parsed query
 * string is `req.query`), so `strict` was always `undefined` and a caller asking for an exact
 * hostname match silently fell back to the wildcard site instead of getting a 404. Fixed by reading
 * `req.query.strict` through the route's existing `Querystring` generic.
 *
 * `WIKI.models.sites.getSiteByHostname` is stubbed to reproduce the real model's strict-vs-wildcard
 * semantics (see `models/sites.ts`) rather than pulling in the db/schema/drizzle graph, keeping this
 * a self-contained unit test of the route's querystring wiring.
 */

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

/**
 * What `getSiteBlocks` returns for the next request, set per-test. Only the fields
 * `siteBlocksInfoFor` (api/sites.ts) actually reads are relevant here — `block`, `isEnabled`,
 * `configFields`, `config`, `id`, `isCustom` — the rest of the real `SiteBlock` shape is irrelevant
 * to this route.
 */
let siteBlocksResult: any[] = []
async function getSiteBlocks(_siteId: string) {
  return siteBlocksResult
}

let app: FastifyInstance

/** Toggled per-test to drive `WIKI.models.renderQueue.isAvailable()`'s stubbed answer. */
let renderingAvailable = true

/**
 * Regression coverage for `manage:theme`: `GroupEditOverlay.vue` and `AdminLayout.vue` present it as
 * a working permission, but `PUT /sites/:siteId` used to gate on `manage:sites` only, so a group
 * holding just `manage:theme` got a 403 the moment it tried to save (or, if the route-level check had
 * been loosened without a body check, could have used it to change anything about the site).
 * `AdminTheme.vue` always sends `{ theme: {...} }` as the entire body, so "only touches `theme`" is
 * exactly what a real save from that page looks like.
 *
 * The route now OR's `manage:theme` into the route-level permission list (mirrored here by the same
 * `preHandler` shape `index.ts` installs, reading permissions off a stubbed `req.session`) and the
 * handler itself refuses a `manage:theme`-only caller whose body reaches beyond the `theme` key.
 */
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
 * Stand-in for `checkSiteAccess()` (task #682): grants whatever `site:*` permission the
 * `x-test-site-permissions` header lists, but only for the site id it names — a request for a
 * different site id gets nothing, which is what exercises that the routes actually thread `siteId`
 * through rather than checking the permission in the abstract.
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

/**
 * Regression test for `POST /_api/sites`'s hand-rolled hostname check: the handler validated
 * `req.body.hostname` against `/^(\*)|([a-z0-9\-.:]+)$/`, but the alternation is ungrouped and the
 * first branch (`\*` — zero or more literal backslashes) matches the empty string, so the whole
 * expression is always true regardless of what follows it — `''` and `'<script>'` both pass. The
 * check never actually validated anything; it was redundant with (and looser than) the body schema's
 * own `pattern: '^(\*|[a-z0-9.-]+)$'`, which Fastify's ajv already enforces before the handler runs.
 * Fixed by deleting the dead hand-rolled check and relying solely on the schema.
 */
const createSiteCalls: Array<{ hostname: string; config: Record<string, any> }> = []
let hostnamesTakenByUnique: Set<string>

async function isHostnameUnique(hostname: string) {
  return !hostnamesTakenByUnique.has(hostname)
}

async function createSite(hostname: string, config: Record<string, any>) {
  createSiteCalls.push({ hostname, config })
  return { id: 'new-site-id' }
}

let enabledSiteCount = 1
async function countEnabledSites() {
  return enabledSiteCount
}

/**
 * Task #1680: `DELETE /:siteId` for an unknown siteId must answer 404, not the pre-existing 400.
 * `countSites` is separate from `countEnabledSites` above (the last-remaining-site guard counts all
 * sites, not just enabled ones) and `deleteSite` returning falsy is what the handler reads as "no
 * such site" -- mirroring `models/sites.ts#deleteSite`'s own not-found return shape.
 */
let siteCount = 2
async function countSites() {
  return siteCount
}
async function deleteSite(id: string) {
  return Boolean(sites[id])
}

before(async () => {
  const wiki = {
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
      auditLog: {
        record: mock.fn(async () => {})
      }
    }
  }

  app = await buildTestApp({
    routes: sitesRoutes,
    wiki,
    ajv: true,
    // -> `session: 'header'` promotes `x-test-permissions` into a real session, so the REAL
    //    route-permission hook exercises the route-level OR-list, not just the handler's own body
    //    check. The function form also captures `x-test-site-permissions` once per request:
    //    `checkSiteAccess()` takes no `req`, so the stub reads the per-test site grants off a
    //    module-level variable.
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
    payload: { hostname: 'WIKI.example.org', title: 'My Wiki' }
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

/**
 * Regression coverage for duplicate-hostname / duplicate-catch-all rejection: `POST /_api/sites`
 * checks `isHostnameUnique` before ever calling `createSite`, and picks between two distinct error
 * messages depending on whether the rejected hostname was `*` or an ordinary one.
 */

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
 * Regression coverage for the last leg of task 699/702's disabled-site contract: unlike the read
 * routes gated elsewhere in this feature, `PUT /:siteId` (behind `manage:sites`) must keep succeeding
 * against an already-disabled site — otherwise nobody could ever flip `isEnabled` back on.
 */

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

/**
 * OpenProject #1893: the route used to maintain a legacy `ratings` boolean alias under `features`,
 * derived on every write from a page-ratings config key that OpenProject #1903 has since removed
 * entirely, despite nothing ever reading the alias. That write has been deleted along with the
 * alias's seeds and JSON Schema entry; a `features` patch should reach `updateSite` carrying only
 * the key that was actually sent, never a synthesized `ratings` key alongside it.
 */
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

/**
 * OpenProject #989: a site settings edit is one of the events the audit log is meant to capture.
 * The tests above stub `auditLog.record` only to keep the route from throwing — this checks it is
 * actually called, with the fields the patch actually touched.
 */
test('a successful update records a site.settingsUpdated audit log entry', async () => {
  ;(globalThis as any).WIKI.models.auditLog.record.mock.resetCalls()
  const res = await app.inject({
    method: 'PUT',
    url: `/${PUT_SITE_ID}`,
    headers: { 'x-test-permissions': 'manage:sites' },
    payload: { title: 'Renamed Again' }
  })
  assert.equal(res.statusCode, 200)
  const calls = (globalThis as any).WIKI.models.auditLog.record.mock.calls
  assert.equal(calls.length, 1)
  const call = calls[0].arguments[0]
  assert.equal(call.event, 'site.settingsUpdated')
  assert.equal(call.targetType, 'site')
  assert.equal(call.targetId, PUT_SITE_ID)
  assert.equal(call.targetLabel, 'Renamed Again')
  assert.deepEqual(call.detail, { changedFields: ['title'] })
})

/**
 * Task #683: `PUT /:siteId` now also accepts the per-surface `site:*` permissions from task #682,
 * checked key by key against `SITE_FIELD_PERMISSIONS` since five surfaces (general/theme/login/
 * locale/editors) share this one route (`docs/decisions/delegated-per-site-administration.md` §3).
 */

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
 * OpenProject #1360/#2208 (2026-08-24 security audit §2): `auth.loginRedirect`/`welcomeRedirect`/
 * `logoutRedirect` had the identical shape and risk as a group's `redirectOnLogin` (see
 * `api/groups.test.ts`) — writable by `manage:sites` or the delegated `site:login` permission, and
 * unvalidated until now. A `site:login` holder is a delegated, non-administrator permission that
 * could otherwise plant `javascript:...` there and have it execute for the next reader
 * `AuthLoginPanel.vue`'s `window.location.replace()` sends through it -- covered from both
 * permission paths below.
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
  const original = WIKI.config.security.disallowOpenRedirect
  WIKI.config.security.disallowOpenRedirect = false
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
    WIKI.config.security.disallowOpenRedirect = original
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

/**
 * `DELETE /:siteId` is deliberately excluded from the `site:*` vocabulary (§3) — it stays a
 * route-level, global-only `manage:sites` gate, so `site:general` alone must not reach it.
 */
test('site:general does not grant DELETE /:siteId, which stays manage:sites-only', async () => {
  const res = await app.inject({
    method: 'DELETE',
    url: `/${PUT_SITE_ID}`,
    headers: {
      // -> A held but unrelated global permission, so the route-level hook's "some permission held"
      //    401 branch is not what refuses this -- the "not one of the route's permissions" 403
      //    branch is, which is the thing this test is actually about.
      'x-test-permissions': 'manage:navigation',
      'x-test-site-permissions': `site:general@${PUT_SITE_ID}`
    }
  })
  assert.equal(res.statusCode, 403)
})

/**
 * Task #1680: an unknown siteId used to fall through to `reply.badRequest()` (400) here -- the only
 * site-scoped route in the API answering that way instead of the 404 every sibling route
 * (`approvals.ts`, `blocks.ts`, `comments.ts`, `blockCredentials.ts`, `search.ts`, `storage.ts`,
 * `glossary.ts`, and `GET /:siteIdorHostname` itself) uses for the same condition.
 */
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

/**
 * Task #683: the site-image routes (`PUT`/`DELETE /:siteId/images/:kind`) split by `kind` —
 * `logo`/`favicon` need `site:general`, `loginBg` needs `site:login` (§3's mapping to the
 * `Admin*.vue` page each image is edited from).
 */

beforeEach(() => {
  setAssetCalls = []
  clearAssetCalls = []
})

// -> A minimal valid PNG, so the route's byte-sniffing validation (after the permission check)
//    passes too, not just the permission gate.
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

/**
 * Task #684: `GET /:siteId/userPermissions` is what `frontend/src/composables/siteAdminAccess.js`
 * asks to decide whether to show the sidebar link / render the page / redirect to
 * `/_error/unauthorized`, for each of the nine site-scoped `Admin*.vue` pages. Mirrors
 * `pages/userPermissions` in `api/pages/read.ts`, but for `site:*` instead of page permissions.
 */

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
 * `manage:sites` deliberately is NOT folded into this list -- `sitePermissionsFor`'s own comment
 * explains why (it would tell the caller they hold `site:navigation`, which `manage:sites` alone
 * does not grant against the real `checkSiteAdminAccess` check in `api/navigation.ts`). The frontend
 * combines this list with `manage:sites` / `manage:theme` / `manage:navigation` itself, per surface.
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

/**
 * Task 500: `pdfExportAvailable` surfaces `WIKI.models.renderQueue.isAvailable()` (whether the
 * Puppeteer extension is installed) on the same payload `siteStore.loadSite` already fetches, so the
 * frontend can gate the PDF export option without a second round trip.
 */
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
 * OpenProject #1922: `docsBase` surfaces `WIKI.config.docsBase` (a `base.yml` default, not per-site
 * config) on the same site-info payload `pdfExportAvailable` above already does, so
 * `siteStore.docsBase` never needs a hardcoded frontend fallback.
 */
test('docsBase reflects WIKI.config.docsBase', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/somehost.example.com'
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().docsBase, 'https://test.docs.example/docs')
})

/**
 * Regression coverage for task 691: the DELETE route already refuses to remove the last remaining
 * site (`countSites() <= 1`); PUT had no equivalent, so an admin could disable the only enabled site
 * with `isEnabled: false` and leave the wiki with no hostname able to resolve. Mirrors the DELETE
 * guard's shape — a 409 conflict, `updateSite` never called — but keyed on `countEnabledSites()`
 * rather than `countSites()`, since a disabled site still exists, it just stops being served.
 */

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

/**
 * `blocksConfig` on the public site-info response, so a reader's browser (block-map, via
 * `blocks/shared/config.js`) can resolve a site's block config without the manage:sites-gated
 * `GET /sites/:siteId/blocks` route. See `blocksConfigFor` in api/sites.ts.
 */
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

/**
 * `blocksIndex` on the same public site-info response, so the page view (`Index.vue`'s block-loading
 * scan, via `siteStore.blocksIndex`) can resolve an undefined `block-*` element to its `id`/`isCustom`
 * without the manage:sites-gated `GET /sites/:siteId/blocks` route either — see `siteBlocksInfoFor`
 * in api/sites.ts and OpenProject #954.
 */
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
