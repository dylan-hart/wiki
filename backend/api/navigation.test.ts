import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import navigationRoutes from './navigation.ts'

/**
 * Task #683: `GET .../navigation/pages/:pageId/inherited` and `PUT .../navigation/pages/:pageId`
 * used to gate on the blanket route-level `manage:navigation` alone. Both routes now also accept the
 * site-scoped `site:navigation` permission from task #682 (`checkSiteAccess()`), checked in-handler
 * via `canManageNavigation` since `config.permissions` cannot express a per-site check.
 */

const SITE_ID = '5d9c8f1e-2b3a-4c5d-9e6f-7a8b9c0d1e2f'
const PAGE_ID = 'a1b2c3d4-e5f6-4789-9abc-def012345678'

let currentSitePermissionHeader: string | undefined
function checkSiteAccess(actor: { permissions: string[] }, permission: string, siteId: string) {
  if (actor.permissions.includes('manage:system')) {
    return true
  }
  return typeof currentSitePermissionHeader === 'string'
    ? currentSitePermissionHeader.split(',').filter(Boolean).includes(`${permission}@${siteId}`)
    : false
}

function actorForRequest(req: any) {
  const header = req.headers['x-test-permissions']
  const permissions = typeof header === 'string' ? header.split(',').filter(Boolean) : []
  return { groupIds: [], permissions }
}

let app: FastifyInstance

before(async () => {
  ;(globalThis as any).WIKI = {
    models: {
      groups: { actorForRequest, checkSiteAccess },
      navigation: {
        inheritedNavId: async () => 'inherited-nav-id',
        updateNavigation: async (opts: any) => ({
          navigationMode: opts.mode,
          navigationId: 'resulting-nav-id'
        }),
        getNav: async () => []
      }
    },
    logger: { warn: () => {} }
  }

  app = fastify()
  await app.register(fastifySensible)
  app.addHook('preHandler', (req: any, reply, done) => {
    currentSitePermissionHeader = req.headers['x-test-site-permissions']
    done()
  })
  await app.register(navigationRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

test('manage:navigation may read the inherited menu', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/navigation/pages/${PAGE_ID}/inherited`,
    headers: { 'x-test-permissions': 'manage:navigation' }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().navigationId, 'inherited-nav-id')
})

test('site:navigation on this site may read the inherited menu', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/navigation/pages/${PAGE_ID}/inherited`,
    headers: { 'x-test-site-permissions': `site:navigation@${SITE_ID}` }
  })
  assert.equal(res.statusCode, 200)
})

test('site:navigation on a DIFFERENT site may not read the inherited menu here', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/navigation/pages/${PAGE_ID}/inherited`,
    headers: { 'x-test-site-permissions': 'site:navigation@some-other-site' }
  })
  assert.equal(res.statusCode, 403)
})

test('a caller with neither manage:navigation nor site:navigation is refused', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/navigation/pages/${PAGE_ID}/inherited`,
    headers: { 'x-test-permissions': 'manage:sites' }
  })
  assert.equal(res.statusCode, 403)
})

test('site:navigation on this site may set how a page resolves its navigation', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/sites/${SITE_ID}/navigation/pages/${PAGE_ID}`,
    headers: { 'x-test-site-permissions': `site:navigation@${SITE_ID}` },
    payload: { mode: 'inherit' }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)
})

test('site:navigation on a DIFFERENT site may not set navigation here', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/sites/${SITE_ID}/navigation/pages/${PAGE_ID}`,
    headers: { 'x-test-site-permissions': 'site:navigation@some-other-site' },
    payload: { mode: 'inherit' }
  })
  assert.equal(res.statusCode, 403)
})

test('reading a menu in full requires manage:navigation or site:navigation on this site', async () => {
  const forbidden = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/navigation/${PAGE_ID}?full=true`,
    headers: { 'x-test-permissions': 'manage:sites' }
  })
  assert.equal(forbidden.statusCode, 403)

  const allowed = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/navigation/${PAGE_ID}?full=true`,
    headers: { 'x-test-site-permissions': `site:navigation@${SITE_ID}` }
  })
  assert.equal(allowed.statusCode, 200)
})
