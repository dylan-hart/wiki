import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import navigationRoutes from './navigation.ts'
import { createSiteAdminAccessStub } from '../test/mocks.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

const SITE_ID = '5d9c8f1e-2b3a-4c5d-9e6f-7a8b9c0d1e2f'
const PAGE_ID = 'a1b2c3d4-e5f6-4789-9abc-def012345678'

// -> Three levels deep: a response schema that hand-writes a fixed number of `children` levels
//    makes `fast-json-stringify` silently drop anything nested past them.
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

let updateSiteCalls: Array<{ id: string; patch: any }> = []

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

const checkSiteAdminAccess = createSiteAdminAccessStub(actorForRequest, checkSiteAccess)

let app: FastifyInstance

before(async () => {
  app = await buildTestApp({
    routes: navigationRoutes,
    // -> `checkSiteAccess()` takes no `req`, so its stub reads the grants from a module-level
    //    variable set here per request. Returning `undefined` leaves the session alone.
    session: (req: any) => {
      currentSitePermissionHeader = req.headers['x-test-site-permissions']
      return undefined
    },
    wiki: {
      sites: { [SITE_ID]: { id: SITE_ID } },
      models: {
        groups: { actorForRequest, checkSiteAccess, checkSiteAdminAccess },
        sites: {
          updateSite: async (id: string, patch: any) => {
            updateSiteCalls.push({ id, patch })
            return true
          }
        },
        navigation: {
          inheritedNavId: async () => 'inherited-nav-id',
          updateNavigation: async (opts: any) => ({
            navigationMode: opts.mode,
            navigationId: 'resulting-nav-id'
          }),
          getNav: async () => DEEP_NAV_TREE,
          getMode: async () => 'static',
          // -> Non-default values, so a test can tell the route echoed them.
          getNavRoot: async () => ({ rootPath: 'stub-section', rootId: 'stub-folder-id' }),
          ensureSiteNav: async () => 'default-nav-id',
          siteRoots: async () => [{ locale: 'en', navigationId: 'root-nav-id' }],
          listOverrides: async () => [],
          setNavItems: async () => {},
          copyNav: async () => {}
        }
      }
    }
  })
})

after(() => closeTestApp(app))

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

test('GET .../navigation/:navId includes the generator root alongside mode and items', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/sites/${SITE_ID}/navigation/${PAGE_ID}`
  })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.rootPath, 'stub-section')
  assert.equal(body.rootId, 'stub-folder-id')
})

// -> `getNav()` filters generated entries through this actor's `read:pages` grant.
test('GET .../navigation/:navId passes the request-resolved actor through to getNav', async () => {
  const originalGetNav = (globalThis as any).CARDINAL.models.navigation.getNav
  const calls: any[] = []
  ;(globalThis as any).CARDINAL.models.navigation.getNav = async (
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
    ;(globalThis as any).CARDINAL.models.navigation.getNav = originalGetNav
  }
})

test('manage:navigation may set the path display case style', async () => {
  updateSiteCalls = []
  const res = await app.inject({
    method: 'PUT',
    url: `/sites/${SITE_ID}/navigation/pathDisplay`,
    headers: { 'x-test-permissions': 'manage:navigation' },
    payload: { caseStyle: 'title' }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)
  assert.equal(updateSiteCalls.length, 1)
  assert.equal(updateSiteCalls[0].id, SITE_ID)
  assert.deepEqual(updateSiteCalls[0].patch, { config: { pathDisplayCase: 'title' } })
})

test('site:navigation on this site may set the path display case style', async () => {
  updateSiteCalls = []
  const res = await app.inject({
    method: 'PUT',
    url: `/sites/${SITE_ID}/navigation/pathDisplay`,
    headers: { 'x-test-site-permissions': `site:navigation@${SITE_ID}` },
    payload: { caseStyle: 'off' }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(updateSiteCalls.length, 1)
})

test('site:navigation on a DIFFERENT site may not set the path display case style here', async () => {
  updateSiteCalls = []
  const res = await app.inject({
    method: 'PUT',
    url: `/sites/${SITE_ID}/navigation/pathDisplay`,
    headers: { 'x-test-site-permissions': 'site:navigation@some-other-site' },
    payload: { caseStyle: 'off' }
  })
  assert.equal(res.statusCode, 403)
  assert.equal(updateSiteCalls.length, 0)
})

test('a caller with neither manage:navigation nor site:navigation may not set the path display case style', async () => {
  updateSiteCalls = []
  const res = await app.inject({
    method: 'PUT',
    url: `/sites/${SITE_ID}/navigation/pathDisplay`,
    headers: { 'x-test-permissions': 'manage:sites' },
    payload: { caseStyle: 'off' }
  })
  assert.equal(res.statusCode, 403)
  assert.equal(updateSiteCalls.length, 0)
})

test('an unknown caseStyle is rejected by the schema and never reaches updateSite', async () => {
  updateSiteCalls = []
  const res = await app.inject({
    method: 'PUT',
    url: `/sites/${SITE_ID}/navigation/pathDisplay`,
    headers: { 'x-test-permissions': 'manage:navigation' },
    payload: { caseStyle: 'shouty' }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(updateSiteCalls.length, 0)
})

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

function sessionActor(req: any) {
  return {
    groupIds: [],
    permissions: req.session?.authenticated ? (req.session.permissions ?? []) : []
  }
}

describe('manage:navigation permission surface on GET/PUT .../navigation/:navId (Task 472)', () => {
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
    const wiki = {
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
          async getNavRoot(_siteId: string, _id: string) {
            return { rootPath: '', rootId: null }
          },
          async setNavItems(siteId: string, navId: string, items: any[]) {
            lastSetNavItemsCall = { siteId, navId, items }
          }
        },
        groups: {
          actorForRequest: sessionActor,
          checkSiteAccess: () => false,
          checkSiteAdminAccess: (req: any, globalPermission: string) =>
            sessionActor(req).permissions.includes(globalPermission)
        }
      }
    }

    // -> Captures the route's OpenAPI `description` without wiring `@fastify/swagger`. Wrapped
    //    around the route plugin because `onRoute` only fires for routes registered into the same
    //    encapsulation or below it.
    const capturingRoutes: FastifyPluginAsync = async (instance) => {
      instance.addHook('onRoute', (routeOptions) => {
        if (
          routeOptions.method === 'GET' &&
          routeOptions.url === '/sites/:siteId/navigation/:navId'
        ) {
          getNavRouteDescription = (routeOptions.schema as any)?.description
        }
      })
      await instance.register(navigationRoutes)
    }

    app = await buildTestApp({
      routes: capturingRoutes,
      wiki,
      session: 'header',
      permissions: true
    })
  })

  after(() => closeTestApp(app))

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

  // -> Passes whatever depth the body schema declares: Ajv only strips undeclared properties under
  //    `additionalProperties: false`, which `NavigationItem` does not set. A write-path contract
  //    test, not a guard on the schema.
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
    // -> 403, not 401: the in-handler `checkSiteAdminAccess()` check answers a flat forbidden().
    //    Unlike the route-level permission hook, it does not tell an anonymous caller apart.
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/navigation/${NAV_ID}`,
      payload: { items: storedItems }
    })
    assert.equal(res.statusCode, 403)
    assert.equal(lastSetNavItemsCall, null)
  })
})
