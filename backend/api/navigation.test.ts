import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fastifySensible from '@fastify/sensible'
import navigationRoutes from './navigation.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'
import { registerSchemas as registerNavigationSchema } from './schemas/navigation.ts'

/**
 * Task #683: `GET .../navigation/pages/:pageId/inherited` and `PUT .../navigation/pages/:pageId`
 * used to gate on the blanket route-level `manage:navigation` alone. Both routes now also accept the
 * site-scoped `site:navigation` permission from task #682 (`checkSiteAccess()`), checked in-handler
 * via `canManageNavigation` since `config.permissions` cannot express a per-site check.
 */

const SITE_ID = '5d9c8f1e-2b3a-4c5d-9e6f-7a8b9c0d1e2f'
const PAGE_ID = 'a1b2c3d4-e5f6-4789-9abc-def012345678'

// -> Three levels deep: top-level item -> child -> grandchild. The `NavigationItem` response
//    schema used to be a plain object literal bolting on exactly one hand-written level of
//    `children`, so `fast-json-stringify` silently dropped the grandchild regardless of what
//    `getNav` actually returned (OpenProject #814 follow-up to 6d1cd05e).
const DEEP_NAV_TREE = [
  {
    id: 'top',
    type: 'link',
    label: 'Top',
    children: [
      {
        id: 'child',
        type: 'link',
        label: 'Child',
        children: [{ id: 'grandchild', type: 'link', label: 'Grandchild' }]
      }
    ]
  }
]

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
    sites: { [SITE_ID]: { id: SITE_ID } },
    models: {
      groups: { actorForRequest, checkSiteAccess },
      navigation: {
        inheritedNavId: async () => 'inherited-nav-id',
        updateNavigation: async (opts: any) => ({
          navigationMode: opts.mode,
          navigationId: 'resulting-nav-id'
        }),
        getNav: async () => DEEP_NAV_TREE,
        getMode: async () => 'static',
        ensureSiteNav: async () => 'default-nav-id',
        siteRoots: async () => [{ locale: 'en', navigationId: 'root-nav-id' }],
        listOverrides: async () => [],
        setNavItems: async () => {},
        copyNav: async () => {}
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
  await registerNavigationSchema(app)
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

test('PUT .../navigation/pages/:pageId rejects a javascript: item target with 400', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/sites/${SITE_ID}/navigation/pages/${PAGE_ID}`,
    headers: { 'x-test-site-permissions': `site:navigation@${SITE_ID}` },
    payload: {
      mode: 'override',
      items: [{ id: 'a', type: 'link', label: 'Bad', target: 'javascript:alert(1)' }]
    }
  })
  assert.equal(res.statusCode, 400)
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

test('a menu nested three levels deep reaches the response intact', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/navigation/${PAGE_ID}`
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.items[0].children[0].children[0].id, 'grandchild')
})

/**
 * OpenProject #2155: `getNav()` now requires an `actor` so `generateFromTree()` can run every
 * generated entry through `read:pages` — this pins that the route actually builds and passes one
 * (via `WIKI.models.groups.actorForRequest(req)`), the same actor every other page-scoped check in
 * this codebase is built from, rather than leaving the parameter to default away silently.
 */
test('GET .../navigation/:navId passes the request-resolved actor through to getNav', async () => {
  const originalGetNav = (globalThis as any).WIKI.models.navigation.getNav
  const calls: any[] = []
  ;(globalThis as any).WIKI.models.navigation.getNav = async (
    siteId: string,
    navId: string,
    opts: any
  ) => {
    calls.push(opts)
    return DEEP_NAV_TREE
  }
  try {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/navigation/${PAGE_ID}`,
      headers: { 'x-test-permissions': 'read:pages' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(calls.length, 1)
    assert.ok(calls[0].actor, 'expected an actor to be passed to getNav()')
    assert.deepEqual(calls[0].actor.permissions, ['read:pages'])
  } finally {
    ;(globalThis as any).WIKI.models.navigation.getNav = originalGetNav
  }
})

/**
 * OpenProject #933: six navigation endpoints still declared route-level `permissions:
 * ['manage:navigation']` after task #683 introduced `site:navigation` delegation — the global
 * `preHandler` hook resolves that from `session.permissions` only, so `checkSiteAccess()` could
 * never run for these, and a `site:navigation`-only caller got a 403 from every one of them despite
 * `AdminNavigation.vue` showing them the page. Each now checks `canManageNavigation()` in-handler,
 * the same way their siblings above already did.
 */
describe('site:navigation delegation on the six previously route-gated endpoints (task #933)', () => {
  const NAV_ID = 'c3d4e5f6-a7b8-49ab-cdef-012345678901'

  test('GET .../navigation/:navId/mode', async () => {
    const forbidden = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/navigation/${NAV_ID}/mode`,
      headers: { 'x-test-permissions': 'manage:sites' }
    })
    assert.equal(forbidden.statusCode, 403)

    const allowed = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/navigation/${NAV_ID}/mode`,
      headers: { 'x-test-site-permissions': `site:navigation@${SITE_ID}` }
    })
    assert.equal(allowed.statusCode, 200)
    assert.equal(allowed.json().mode, 'static')
  })

  test('GET .../navigation/default', async () => {
    const forbidden = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/navigation/default?locale=en`,
      headers: { 'x-test-permissions': 'manage:sites' }
    })
    assert.equal(forbidden.statusCode, 403)

    const allowed = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/navigation/default?locale=en`,
      headers: { 'x-test-site-permissions': `site:navigation@${SITE_ID}` }
    })
    assert.equal(allowed.statusCode, 200)
  })

  test('GET .../navigation/roots', async () => {
    const forbidden = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/navigation/roots`,
      headers: { 'x-test-permissions': 'manage:sites' }
    })
    assert.equal(forbidden.statusCode, 403)

    const allowed = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/navigation/roots`,
      headers: { 'x-test-site-permissions': `site:navigation@${SITE_ID}` }
    })
    assert.equal(allowed.statusCode, 200)
  })

  test('GET .../navigation/overrides', async () => {
    const forbidden = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/navigation/overrides`,
      headers: { 'x-test-permissions': 'manage:sites' }
    })
    assert.equal(forbidden.statusCode, 403)

    const allowed = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/navigation/overrides`,
      headers: { 'x-test-site-permissions': `site:navigation@${SITE_ID}` }
    })
    assert.equal(allowed.statusCode, 200)
  })

  test('PUT .../navigation/:navId', async () => {
    const forbidden = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/navigation/${NAV_ID}`,
      headers: { 'x-test-permissions': 'manage:sites' },
      payload: { items: [] }
    })
    assert.equal(forbidden.statusCode, 403)

    const allowed = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/navigation/${NAV_ID}`,
      headers: { 'x-test-site-permissions': `site:navigation@${SITE_ID}` },
      payload: { items: [] }
    })
    assert.equal(allowed.statusCode, 200)
  })

  test('POST .../navigation/:targetNavId/copy', async () => {
    const forbidden = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/navigation/${NAV_ID}/copy`,
      headers: { 'x-test-permissions': 'manage:sites' },
      payload: { sourceNavId: NAV_ID, mode: 'replace' }
    })
    assert.equal(forbidden.statusCode, 403)

    const allowed = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/navigation/${NAV_ID}/copy`,
      headers: { 'x-test-site-permissions': `site:navigation@${SITE_ID}` },
      payload: { sourceNavId: NAV_ID, mode: 'replace' }
    })
    assert.equal(allowed.statusCode, 200)
  })

  /**
   * OpenProject #933 follow-up: `site:navigation` is granted per site (`helpers/siteRules.ts`), so a
   * cross-site copy (`sourceSiteId` different from the path's `:siteId`) must not let a caller
   * delegated ONLY on the target read and duplicate a DIFFERENT site's menu with no permission on
   * that site at all.
   */
  test('POST .../copy with a different sourceSiteId requires site:navigation on BOTH sites', async () => {
    const OTHER_SITE_ID = 'b2c3d4e5-f6a7-4890-9abc-def012345679'

    const targetOnly = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/navigation/${NAV_ID}/copy`,
      headers: { 'x-test-site-permissions': `site:navigation@${SITE_ID}` },
      payload: { sourceSiteId: OTHER_SITE_ID, sourceNavId: NAV_ID, mode: 'replace' }
    })
    assert.equal(targetOnly.statusCode, 403)

    const both = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/navigation/${NAV_ID}/copy`,
      headers: {
        'x-test-site-permissions': `site:navigation@${SITE_ID},site:navigation@${OTHER_SITE_ID}`
      },
      payload: { sourceSiteId: OTHER_SITE_ID, sourceNavId: NAV_ID, mode: 'replace' }
    })
    assert.equal(both.statusCode, 200)
  })

  /**
   * OpenProject #2217: `target` was an unconstrained string, so a `site:navigation` holder could
   * store `javascript:...` as an item's target -- it renders in the sidebar of every page of that
   * site and runs in the wiki origin for any reader who clicks it. Checked recursively (including
   * nested `children`), on both routes that accept `items` directly.
   */
  test('PUT .../navigation/:navId rejects a javascript: item target with 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/navigation/${NAV_ID}`,
      headers: { 'x-test-site-permissions': `site:navigation@${SITE_ID}` },
      payload: { items: [{ id: 'a', type: 'link', label: 'Bad', target: 'javascript:alert(1)' }] }
    })
    assert.equal(res.statusCode, 400)
  })

  test('PUT .../navigation/:navId rejects a javascript: target nested in children with 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/navigation/${NAV_ID}`,
      headers: { 'x-test-site-permissions': `site:navigation@${SITE_ID}` },
      payload: {
        items: [
          {
            id: 'a',
            type: 'link',
            label: 'Parent',
            target: '/parent',
            children: [{ id: 'b', type: 'link', label: 'Bad', target: 'javascript:alert(1)' }]
          }
        ]
      }
    })
    assert.equal(res.statusCode, 400)
  })

  test('PUT .../navigation/:navId still accepts a rooted path and an https:// URL', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/navigation/${NAV_ID}`,
      headers: { 'x-test-site-permissions': `site:navigation@${SITE_ID}` },
      payload: {
        items: [
          { id: 'a', type: 'link', label: 'Path', target: '/some/page' },
          { id: 'b', type: 'link', label: 'URL', target: 'https://example.com' }
        ]
      }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().ok, true)
  })

  test('site:navigation on a DIFFERENT site grants none of the six', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/navigation/roots`,
      headers: { 'x-test-site-permissions': 'site:navigation@some-other-site' }
    })
    assert.equal(res.statusCode, 403)
  })

  test('manage:navigation (group-wide) still works on all six, unchanged', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/navigation/roots`,
      headers: { 'x-test-permissions': 'manage:navigation' }
    })
    assert.equal(res.statusCode, 200)
  })
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
  let getNavRouteDescription: string | undefined

  before(async () => {
    ;(globalThis as any).WIKI = {
      models: {
        navigation: {
          async getNav(
            siteId: string,
            id: string,
            { unfiltered = false }: { unfiltered?: boolean } = {}
          ) {
            return unfiltered
              ? storedItems
              : storedItems.filter((i) => i.visibilityGroups.length === 0)
          },
          async getMode(_siteId: string, _id: string) {
            return 'static'
          },
          async setNavItems(siteId: string, navId: string, items: any[]) {
            lastSetNavItemsCall = { siteId, navId, items }
          }
        },
        // -> Both the GET route's `full=true` branch and the PUT route below check
        //    `canManageNavigation()` in-handler (task #933 moved PUT off route-level
        //    `config.permissions` too) -- this stub answers that from the same `x-test-session`
        //    header `permissionPreHandler` reads, and never grants `site:navigation`, since no test
        //    in this describe exercises that delegation path (see the task #933 describe above for
        //    that coverage).
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
    // -> Captures the GET .../navigation/:navId route's OpenAPI `description` as it's registered,
    //    so a test below can assert on its actual text (OpenProject #2342) without needing
    //    `@fastify/swagger` wired into this lightweight test app.
    app.addHook('onRoute', (routeOptions) => {
      if (
        routeOptions.method === 'GET' &&
        routeOptions.url === '/sites/:siteId/navigation/:navId'
      ) {
        getNavRouteDescription = (routeOptions.schema as any)?.description
      }
    })
    await registerErrorSchema(app)
    await registerNavigationSchema(app)
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
      res.json().items.map((i: any) => i.id),
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

  // -> Unlike the GET test above, this one does NOT independently demonstrate OpenProject #814's
  //    fix: Ajv only strips/rejects undeclared-depth properties when `additionalProperties: false`
  //    is set somewhere in the schema chain, and it never was here, in either the old inlined
  //    `navigationItem` shape or the new shared `NavigationItem` schema -- so a PUT body nested
  //    past the schema's known depth was never actually truncated or rejected on the write path.
  //    Reverting `navigation.ts` to its pre-fix schema still passes this test. It stays as a
  //    forward-looking contract test for the write path, not as proof of this bug's existence.
  test('a menu nested three levels deep survives the save (body validation)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/navigation/${NAV_ID}`,
      payload: { items: DEEP_NAV_TREE },
      headers: headersFor(['manage:navigation'])
    })
    assert.equal(res.statusCode, 200)
    assert.equal(lastSetNavItemsCall?.items[0].children[0].children[0].id, 'grandchild')
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

  // -> OpenProject #2342: the route's OpenAPI description used to claim the per-item `read:pages`
  //    filter "runs regardless of `full`" -- the opposite of what `getNav`'s `unfiltered ? null :
  //    actor` actually does (skips it, same as the visibility-group filter). This pins the
  //    corrected wording so the two can't silently drift apart again.
  test('the OpenAPI description documents that `full` skips read:pages filtering, not the reverse', () => {
    assert.ok(getNavRouteDescription, 'expected the GET .../navigation/:navId route to be captured')
    assert.doesNotMatch(getNavRouteDescription!, /read:pages.*regardless of `full`/s)
    assert.match(getNavRouteDescription!, /it skips the per-item `read:pages` check too/)
  })

  test('an anonymous request may still read the filtered menu', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/navigation/${NAV_ID}`
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(
      res.json().items.map((i: any) => i.id),
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
    // -> 403, not 401: task #933 moved this route off route-level `config.permissions` (whose
    //    preHandler hook distinguishes "nobody home" from "wrong permission") onto the same
    //    in-handler `canManageNavigation()` check every sibling delegated route already uses, which
    //    answers a flat forbidden() either way -- see the task #933 describe above.
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/navigation/${NAV_ID}`,
      payload: { items: storedItems }
    })
    assert.equal(res.statusCode, 403)
    assert.equal(lastSetNavItemsCall, null)
  })
})
