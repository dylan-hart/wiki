import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fastifySensible from '@fastify/sensible'
import navigationRoutes from './navigation.ts'

/**
 * Task 472: verifies the `manage:navigation` permission surface on the two routes gated by it in this
 * file has no gap and is no more permissive than intended, for an account holding EXACTLY
 * `manage:navigation` — no `manage:sites`, no `manage:system`.
 *
 * The route-level `config.permissions` gate itself lives in a single global `preHandler` hook
 * registered by `index.ts`, not by this route file, so it is reproduced here verbatim (same OR/AND
 * shape, same `manage:system` bypass) rather than pulled in from the real server bootstrap — mirroring
 * `api/sites.test.ts`'s approach of exercising a route file in isolation with `WIKI` stubbed. A session
 * carrying only `['manage:navigation']` is exactly what `models/users.ts`'s `updateSession` would
 * flatten onto `req.session.permissions` for a user in a group granted nothing else, per
 * CLAUDE.md's "Permissions" section — so asserting against that session is equivalent to asserting
 * against a real such account without needing a live database.
 */

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
      }
    }
  }

  app = fastify()
  await app.register(fastifySensible)
  app.addHook('onRequest', testSessionOnRequest)
  app.addHook('preHandler', permissionPreHandler)
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
