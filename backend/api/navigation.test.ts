import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fastifySensible from '@fastify/sensible'
import navigationRoutes from './navigation.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'

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
  // -> Mirrors `index.ts`'s real `setErrorHandler`: a `reply.notFound()`/`forbidden()`/etc. is a
  //    thrown `@fastify/sensible` error, and it is THIS handler -- not fastify's default -- that
  //    shapes it into the `{ ok, error, statusCode, message }` the `ApiError` schema expects.
  app.setErrorHandler((error: any, req, reply) => {
    reply.code(error.statusCode ?? 500).send({
      ok: false,
      error: error.name,
      statusCode: error.statusCode ?? 500,
      message: error.message
    })
  })
  await registerErrorSchema(app)
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

describe('manage:navigation permission surface on GET/PUT .../navigation/:navId (Task 472)', () => {
  /**
   * No session plugin is registered in this isolated app (see comment above), so a test seeds
   * `req.session` itself via an `x-test-session` header carrying the JSON a real session would already
   * hold by the time it reaches a route -- decoded before the permission hook runs, exactly where the
   * real session plugin would sit in the chain.
   */
  function testSessionOnRequest(
    req: FastifyRequest,
    _reply: FastifyReply,
    done: (err?: Error) => void
  ) {
    const header = req.headers['x-test-session']
    if (header) {
      ;(req as any).session = JSON.parse(header as string)
    }
    done()
  }

  function permissionPreHandler(
    req: FastifyRequest,
    reply: FastifyReply,
    done: (err?: Error) => void
  ) {
    const routePermissions = req.routeOptions.config?.permissions
    if (routePermissions && routePermissions.length > 0) {
      const session = (req as any).session
      const permissions = session?.authenticated ? session.permissions : null
      if (!permissions || permissions.length < 1) {
        return reply.unauthorized()
      }
      if (!permissions.includes('manage:system')) {
        const isAllowed = routePermissions.some((perms: any) => {
          if (Array.isArray(perms)) {
            return perms.every((perm: string) => permissions.some((p: string) => p === perm))
          }
          return permissions.some((p: string) => p === perms)
        })
        if (!isAllowed) {
          return reply.forbidden()
        }
      }
    }
    done()
  }

  const SITE_ID = '11111111-1111-1111-1111-111111111111'
  const NAV_ID = '22222222-2222-2222-2222-222222222222'

  const storedItems = [
    { id: 'a', type: 'link', label: 'Public', target: '/public', visibilityGroups: [] },
    { id: 'b', type: 'link', label: 'Secret', target: '/secret', visibilityGroups: ['some-group'] }
  ]

  let app: FastifyInstance
  let lastSetNavItemsCall: { siteId: string; navId: string; items: any[] } | null = null

  before(async () => {
    ;(globalThis as any).WIKI = {
      models: {
        navigation: {
          async getNav(id: string, { unfiltered = false }: { unfiltered?: boolean } = {}) {
            return unfiltered
              ? storedItems
              : storedItems.filter((i) => i.visibilityGroups.length === 0)
          },
          async setNavItems(siteId: string, navId: string, items: any[]) {
            lastSetNavItemsCall = { siteId, navId, items }
          }
        },
        // -> The GET route's `full=true` branch checks `canManageNavigation()` in-handler (it has no
        //    route-level `config.permissions`, unlike PUT below) -- this stub answers that from the
        //    same `x-test-session` header `permissionPreHandler` reads, and never grants
        //    `site:navigation`, since no test in this describe exercises that delegation path.
        groups: {
          actorForRequest: (req: any) => ({
            groupIds: [],
            permissions: (req as any).session?.authenticated
              ? ((req as any).session.permissions ?? [])
              : []
          }),
          checkSiteAccess: () => false
        }
      }
    }

    app = fastify()
    await app.register(fastifySensible)
    // -> Mirrors `index.ts`'s real `setErrorHandler`: a `reply.notFound()`/`forbidden()`/etc. is a
    //    thrown `@fastify/sensible` error, and it is THIS handler -- not fastify's default -- that
    //    shapes it into the `{ ok, error, statusCode, message }` the `ApiError` schema expects.
    app.setErrorHandler((error: any, req, reply) => {
      reply.code(error.statusCode ?? 500).send({
        ok: false,
        error: error.name,
        statusCode: error.statusCode ?? 500,
        message: error.message
      })
    })
    app.addHook('onRequest', testSessionOnRequest)
    app.addHook('preHandler', permissionPreHandler)
    await registerErrorSchema(app)
    await app.register(navigationRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  beforeEach(() => {
    lastSetNavItemsCall = null
  })

  function headersFor(permissions: string[]) {
    return {
      'x-test-session': JSON.stringify({ authenticated: true, permissions, groups: [] })
    }
  }

  test('a manage:navigation-only account can read a menu in full (?full=true)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/navigation/${NAV_ID}?full=true`,
      headers: headersFor(['manage:navigation'])
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(
      res.json().map((i: any) => i.id),
      ['a', 'b']
    )
  })

  test('a manage:navigation-only account can save a menu', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/navigation/${NAV_ID}`,
      payload: { items: storedItems },
      headers: headersFor(['manage:navigation'])
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().ok, true)
    assert.equal(lastSetNavItemsCall?.navId, NAV_ID)
  })

  test('an account without manage:navigation is refused a full read', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/navigation/${NAV_ID}?full=true`,
      headers: headersFor(['read:pages'])
    })
    assert.equal(res.statusCode, 403)
  })

  test('an anonymous request is refused a full read', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/navigation/${NAV_ID}?full=true`
    })
    assert.equal(res.statusCode, 403)
  })

  test('an anonymous request may still read the filtered menu', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/navigation/${NAV_ID}`
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(
      res.json().map((i: any) => i.id),
      ['a']
    )
  })

  test('an account without manage:navigation is refused a save', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/navigation/${NAV_ID}`,
      payload: { items: storedItems },
      headers: headersFor(['read:pages'])
    })
    assert.equal(res.statusCode, 403)
    assert.equal(lastSetNavItemsCall, null)
  })

  test('an anonymous request is refused a save', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/navigation/${NAV_ID}`,
      payload: { items: storedItems }
    })
    assert.equal(res.statusCode, 401)
    assert.equal(lastSetNavItemsCall, null)
  })
})
