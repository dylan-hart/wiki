import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import sitesRoutes from './sites.ts'
import { registerSchemas as registerSiteSchema } from './schemas/site.ts'
import { SITE_PERMISSIONS } from '../helpers/siteRules.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'

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

let app: FastifyInstance

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

before(async () => {
  ;(globalThis as any).WIKI = {
    models: {
      sites: {
        getSiteByHostname,
        getSiteById,
        updateSite,
        setAsset,
        clearAsset
      },
      groups: {
        actorForRequest,
        checkSiteAccess
      },
      locales: {
        getLocales: async () => [{ code: 'en' }]
      }
    },
    logger: { warn: () => {} }
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
  // -> Mirrors `index.ts`'s real `setErrorHandler`: a `reply.notFound()` etc. is a thrown
  //    `@fastify/sensible` error, and it is THIS handler — not fastify's default — that shapes it
  //    into the `{ ok, error, statusCode, message }` the `ApiError` schema below expects.
  app.setErrorHandler((error: any, req, reply) => {
    reply.code(error.statusCode ?? 500).send({
      ok: false,
      error: error.name,
      statusCode: error.statusCode ?? 500,
      message: error.message
    })
  })
  await registerErrorSchema(app)
  await registerSiteSchema(app)
  // -> Mirrors the real route-level permission hook from `index.ts`, reading permissions off a
  //    stubbed session instead of a real one, so the route-level OR-list is exercised too, not just
  //    the handler's own body check.
  app.addHook('preHandler', (req: any, reply, done) => {
    // -> `checkSiteAccess()` takes no `req`, so the stub reads the per-test site-permission grants
    //    off a module-level variable populated here, once per request, from the same header the
    //    handler-level tests set.
    currentSitePermissionHeader = req.headers['x-test-site-permissions']
    const routePermissions = req.routeOptions.config?.permissions
    if (routePermissions && routePermissions.length > 0) {
      const header = req.headers['x-test-permissions']
      const permissions = typeof header === 'string' ? header.split(',').filter(Boolean) : []
      if (permissions.length < 1) {
        return reply.unauthorized()
      }
      if (!permissions.includes('manage:system')) {
        const isAllowed = routePermissions.some((perms: any) =>
          Array.isArray(perms)
            ? perms.every((perm: string) => permissions.includes(perm))
            : permissions.includes(perms)
        )
        if (!isAllowed) {
          return reply.forbidden()
        }
      }
    }
    done()
  })
  await app.register(sitesRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

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
      'x-test-permissions': 'read:sites',
      'x-test-site-permissions': `site:general@${PUT_SITE_ID}`
    }
  })
  assert.equal(res.statusCode, 403)
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
 * `pages/userPermissions` in `api/pages.ts`, but for `site:*` instead of page permissions.
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
 * does not grant against the real `canManageNavigation` check in `api/navigation.ts`). The frontend
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
