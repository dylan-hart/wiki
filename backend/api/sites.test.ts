import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import sitesRoutes from './sites.ts'
import { registerSchemas as registerSiteSchema } from './schemas/site.ts'

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

function actorForRequest(req: any) {
  const header = req.headers['x-test-permissions']
  const permissions = typeof header === 'string' ? header.split(',').filter(Boolean) : []
  return { groupIds: [], permissions }
}

before(async () => {
  ;(globalThis as any).WIKI = {
    models: {
      sites: {
        getSiteByHostname,
        getSiteById,
        updateSite
      },
      groups: {
        actorForRequest
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
  await registerSiteSchema(app)
  // -> Mirrors the real route-level permission hook from `index.ts`, reading permissions off a
  //    stubbed session instead of a real one, so the route-level OR-list is exercised too, not just
  //    the handler's own body check.
  app.addHook('preHandler', (req: any, reply, done) => {
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

test('a caller with neither manage:sites nor manage:theme is refused at the route gate', async () => {
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
