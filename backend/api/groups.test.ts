import assert from 'node:assert/strict'
import { after, before, describe, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import groupsRoutes from './groups.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

/**
 * DB-backed rather than a stub of `CARDINAL.models.groups`: `clampGuestPatch` is private to the
 * real `Groups` class and reachable only through `updateGroup`, so a stubbed model would prove
 * nothing about the guard running.
 */
describe(
  'PUT /:groupId — guests-group role clamp (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let app: FastifyInstance
    let fixtures: TestFixtures
    let groupsModel: typeof import('../models/groups.ts').groups

    before(async () => {
      fixtures = await setupTestDb()
      ;({ groups: groupsModel } = await import('../models/groups.ts'))
      // -> `clampGuestPatch` only activates for the group id this points at.
      ;(globalThis as any).CARDINAL.data.systemIds = { guestsGroupId: fixtures.groupId }

      // -> No `wiki`: `setupTestDb()` already installed the global this suite runs against.
      app = await buildTestApp({ routes: groupsRoutes, ajv: true })
    })

    after(async () => {
      await closeTestApp(app)
      await teardownTestDb()
    })

    test('drops a disallowed role rather than rejecting the request', async () => {
      const warn = mock.method(CARDINAL.logger, 'warn')

      const res = await app.inject({
        method: 'PUT',
        url: `/${fixtures.groupId}`,
        payload: {
          rules: [
            {
              id: 'attempted-write-grant',
              name: 'Attempted write grant',
              // -> 'read:pages' is in GUEST_ROLES; 'write:pages' and 'manage:pages' are not.
              roles: ['read:pages', 'write:pages', 'manage:pages'],
              match: 'START',
              mode: 'ALLOW',
              path: '',
              locales: [],
              sites: []
            }
          ]
        }
      })

      assert.equal(res.statusCode, 200)
      assert.equal(res.json().ok, true)

      const saved = await groupsModel.getGroupById(fixtures.groupId)
      assert.deepEqual(saved?.rules[0]!.roles, ['read:pages'])

      assert.ok(
        warn.mock.calls.length > 0,
        'expected CARDINAL.logger.warn to fire when roles are dropped'
      )
      assert.equal(warn.mock.calls[0]!.arguments[0], 'auth')
      assert.match(warn.mock.calls[0]!.arguments[1] as string, /dropped/i)

      warn.mock.restore()
    })

    test('a patch with only already-allowed roles does not warn', async () => {
      const warn = mock.method(CARDINAL.logger, 'warn')

      const res = await app.inject({
        method: 'PUT',
        url: `/${fixtures.groupId}`,
        payload: {
          rules: [
            {
              id: 'allowed-only',
              name: 'Allowed only',
              roles: ['read:pages', 'read:comments'],
              match: 'START',
              mode: 'ALLOW',
              path: '',
              locales: [],
              sites: []
            }
          ]
        }
      })

      assert.equal(res.statusCode, 200)
      const saved = await groupsModel.getGroupById(fixtures.groupId)
      assert.deepEqual(saved?.rules[0]!.roles, ['read:pages', 'read:comments'])
      assert.equal(warn.mock.calls.length, 0)

      warn.mock.restore()
    })

    test('rejects a javascript: redirectOnLogin with 400, and does not save it', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/${fixtures.groupId}`,
        payload: { redirectOnLogin: 'javascript:alert(1)' }
      })
      assert.equal(res.statusCode, 400)

      const saved = await groupsModel.getGroupById(fixtures.groupId)
      assert.notEqual(saved?.redirectOnLogin, 'javascript:alert(1)')
    })

    test('rejects a scheme-relative //host redirectOnFirstLogin with 400', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/${fixtures.groupId}`,
        payload: { redirectOnFirstLogin: '//attacker.example' }
      })
      assert.equal(res.statusCode, 400)
    })

    test('accepts a rooted path and a complete https:// URL for redirectOnLogout', async () => {
      for (const target of ['/dashboard', 'https://example.com/goodbye']) {
        const res = await app.inject({
          method: 'PUT',
          url: `/${fixtures.groupId}`,
          payload: { redirectOnLogout: target }
        })
        assert.equal(res.statusCode, 200)
        const saved = await groupsModel.getGroupById(fixtures.groupId)
        assert.equal(saved?.redirectOnLogout, target)
      }
    })

    test('accepts an empty string — the seeded default meaning "no redirect configured"', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/${fixtures.groupId}`,
        payload: { redirectOnLogin: '' }
      })
      assert.equal(res.statusCode, 200)
    })

    test('POST / answers 409 for a name that differs only in case or spacing', async () => {
      const created = await app.inject({ method: 'POST', url: '/', payload: { name: 'Curators' } })
      assert.equal(created.statusCode, 200)

      const res = await app.inject({ method: 'POST', url: '/', payload: { name: ' curators ' } })
      assert.equal(res.statusCode, 409)
      assert.equal(res.json().ok, false)
    })

    test('PUT /:groupId answers 409 for a rename onto another group name, and leaves the name alone', async () => {
      const other = await app.inject({ method: 'POST', url: '/', payload: { name: 'Stewards' } })
      const otherId = other.json().id as string

      const res = await app.inject({
        method: 'PUT',
        url: `/${otherId}`,
        payload: { name: 'FIXTURE GROUP' }
      })
      assert.equal(res.statusCode, 409)
      assert.equal((await groupsModel.getGroupById(otherId))?.name, 'Stewards')
    })
  }
)

describe(
  'PUT /:groupId — CLASSIFICATION rule round-trip (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let app: FastifyInstance
    let fixtures: TestFixtures
    let groupsModel: typeof import('../models/groups.ts').groups

    before(async () => {
      fixtures = await setupTestDb()
      ;({ groups: groupsModel } = await import('../models/groups.ts'))
      // -> Not the guests group, so `clampGuestPatch` stays out of the way.
      ;(globalThis as any).CARDINAL.data.systemIds = { guestsGroupId: 'not-this-group' }

      app = await buildTestApp({ routes: groupsRoutes, ajv: true })
    })

    after(async () => {
      await closeTestApp(app)
      await teardownTestDb()
    })

    test('accepts a CLASSIFICATION rule and reads its classifications array back intact', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/${fixtures.groupId}`,
        payload: {
          rules: [
            {
              id: 'classification-rule',
              name: 'Restricted classification',
              roles: ['read:pages'],
              match: 'CLASSIFICATION',
              mode: 'DENY',
              path: '',
              locales: [],
              sites: [],
              classifications: [fixtures.classificationId]
            }
          ]
        }
      })

      assert.equal(res.statusCode, 200)
      assert.equal(res.json().ok, true)

      const saved = await groupsModel.getGroupById(fixtures.groupId)
      assert.equal(saved?.rules[0]!.match, 'CLASSIFICATION')
      assert.deepEqual(saved?.rules[0]!.classifications, [fixtures.classificationId])
    })
  }
)

/**
 * The single-field PUT tests never send a real group's fetched `permissions` array back. This one
 * does, so it catches `createGroup()` seeding a value the body schema's closed enum rejects.
 */
describe(
  'PUT /:groupId — full round-trip of a real seeded group (regression for OpenProject #2555)',
  { skip: !hasTestDatabase() },
  () => {
    let app: FastifyInstance
    let groupsModel: typeof import('../models/groups.ts').groups

    before(async () => {
      await setupTestDb()
      ;({ groups: groupsModel } = await import('../models/groups.ts'))
      // -> Not the guests group, so `clampGuestPatch` stays out of the way.
      ;(globalThis as any).CARDINAL.data.systemIds = { guestsGroupId: 'not-this-group' }
      // -> `PUT /:groupId` reads `config.auth.rootAdminGroupId` whenever `permissions` is sent, and
      //    `setupTestDb()` leaves `config` as `{}`.
      ;(globalThis as any).CARDINAL.config.auth = { rootAdminGroupId: 'not-this-group-either' }

      app = await buildTestApp({ routes: groupsRoutes, ajv: true })
    })

    after(async () => {
      await closeTestApp(app)
      await teardownTestDb()
    })

    test('saving a freshly-created group exactly as fetched does not 400', async () => {
      const groupId = await groupsModel.createGroup('OpenProject 2555 Round Trip Group')

      const getRes = await app.inject({ method: 'GET', url: `/${groupId}` })
      assert.equal(getRes.statusCode, 200)
      const fetched = getRes.json()

      const putRes = await app.inject({
        method: 'PUT',
        url: `/${groupId}`,
        payload: {
          name: fetched.name,
          redirectOnLogin: fetched.redirectOnLogin ?? '',
          redirectOnFirstLogin: fetched.redirectOnFirstLogin ?? '',
          redirectOnLogout: fetched.redirectOnLogout ?? '',
          permissions: fetched.permissions,
          rules: fetched.rules
        }
      })

      assert.equal(putRes.statusCode, 200)
      assert.equal(putRes.json().ok, true)
    })
  }
)

/**
 * Permission surface, against a stubbed `CARDINAL.models.groups`: `GET /` must stay broad enough
 * for the group pickers, while `GET /:groupId` -- whose `Group` carries the permissions and rules
 * `GroupCore` omits -- still requires `read:groups` or `manage:groups`.
 */

const GROUP_ID = '33333333-3333-3333-3333-333333333333'

const fullGroup = {
  id: GROUP_ID,
  name: 'Editors',
  isSystem: false,
  userCount: 3,
  permissions: ['write:pages', 'manage:groups'],
  rules: []
}

let app: FastifyInstance

before(async () => {
  const wiki = {
    config: {
      auth: {
        // -> Distinct from GROUP_ID, so the PUT handler's root-admin guard never activates.
        rootAdminGroupId: '99999999-9999-9999-9999-999999999999'
      }
    },
    models: {
      groups: {
        async getAllGroups() {
          return [{ id: GROUP_ID, name: 'Editors', isSystem: false, userCount: 3 }]
        },
        async getGroupById(id: string) {
          return id === GROUP_ID ? fullGroup : null
        },
        async updateGroup() {
          return true
        },
        holdsSystemPermission() {
          return true
        },
        // -> Carries the test-only `x-test-site-roles` header to `mayHoldPermissionSomewhere`
        //    below, which never sees `req` itself.
        actorForRequest(req: any) {
          const header = req.headers['x-test-site-roles']
          return {
            groupIds: [],
            permissions: req.session?.authenticated ? (req.session.permissions ?? []) : [],
            testSiteRoles: typeof header === 'string' ? header.split(',').filter(Boolean) : []
          }
        },
        // -> The route calls this site-blind (`siteId: null`), so the third argument is ignored.
        mayHoldPermissionSomewhere(actor: { testSiteRoles?: string[] }, permissions: string[]) {
          return permissions.some((permission) => (actor.testSiteRoles ?? []).includes(permission))
        }
      },
      sessions: {
        async clearSessionsForGroup() {}
      },
      auditLog: {
        async record() {}
      }
    }
  }

  app = await buildTestApp({
    routes: groupsRoutes,
    wiki,
    session: 'header',
    permissions: true
  })
})

after(() => closeTestApp(app))

/** `siteRoles` stands in for grants held on a site-scoped rule, not the group-wide list. */
function headersFor(permissions: string[], siteRoles: string[] = []) {
  return {
    'x-test-session': JSON.stringify({ authenticated: true, permissions, groups: [] }),
    'x-test-site-roles': siteRoles.join(',')
  }
}

test('a manage:navigation-only account can list groups (for the visibilityGroups picker)', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/',
    headers: headersFor(['manage:navigation'])
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), [{ id: GROUP_ID, name: 'Editors', isSystem: false, userCount: 3 }])
})

test('a manage:navigation-only account is refused a group detail read', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/${GROUP_ID}`,
    headers: headersFor(['manage:navigation'])
  })
  assert.equal(res.statusCode, 403)
})

test('a manage:sites (group-wide) account can list groups', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/',
    headers: headersFor(['manage:sites'])
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), [{ id: GROUP_ID, name: 'Editors', isSystem: false, userCount: 3 }])
})

test('a manage:sites (group-wide) account is still refused a group detail read', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/${GROUP_ID}`,
    headers: headersFor(['manage:sites'])
  })
  assert.equal(res.statusCode, 403)
})

/** Refused here, `AdminApprovals.vue`'s approval-rule group pickers render empty. */
test('a site:approvals delegate (site-scoped rule only, no group-wide permission) can list groups', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/',
    headers: headersFor([], ['site:approvals'])
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), [{ id: GROUP_ID, name: 'Editors', isSystem: false, userCount: 3 }])
})

test('a site:approvals delegate is still refused a group detail read', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/${GROUP_ID}`,
    headers: headersFor([], ['site:approvals'])
  })
  assert.equal(res.statusCode, 403)
})

/** The same, for `NavItemEditor`'s visibility picker. */
test('a site:navigation delegate (site-scoped rule only, no group-wide permission) can list groups', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/',
    headers: headersFor([], ['site:navigation'])
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), [{ id: GROUP_ID, name: 'Editors', isSystem: false, userCount: 3 }])
})

test('a site:navigation delegate is still refused a group detail read', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/${GROUP_ID}`,
    headers: headersFor([], ['site:navigation'])
  })
  assert.equal(res.statusCode, 403)
})

test('an account with neither read:groups, manage:groups, manage:navigation, manage:sites nor a site:approvals/site:navigation rule is refused the list', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/',
    headers: headersFor(['write:pages'])
  })
  assert.equal(res.statusCode, 403)
})

/**
 * `GET /` declares no route-level `permissions`, so `permissionPreHandler` never runs to 401 an
 * anonymous caller, and `mayListGroups()` cannot tell "no session" from "no relevant grant".
 */
test('an anonymous request is refused the list, with 403 rather than 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/' })
  assert.equal(res.statusCode, 403)
})

test('PUT rejects an unknown global permission string with 400', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${GROUP_ID}`,
    headers: headersFor(['manage:groups']),
    payload: {
      permissions: ['manage:navigations']
    }
  })
  assert.equal(res.statusCode, 400)
})

test('PUT rejects an unknown rule role string with 400', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${GROUP_ID}`,
    headers: headersFor(['manage:groups']),
    payload: {
      rules: [
        {
          id: 'bad-role',
          name: 'Bad role',
          roles: ['write:page'],
          match: 'START',
          mode: 'ALLOW',
          path: '',
          locales: [],
          sites: []
        }
      ]
    }
  })
  assert.equal(res.statusCode, 400)
})

test('PUT accepts a known global permission and a known rule role', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: `/${GROUP_ID}`,
    headers: headersFor(['manage:groups']),
    payload: {
      permissions: ['manage:navigation'],
      rules: [
        {
          id: 'good-role',
          name: 'Good role',
          roles: ['write:pages', 'site:theme'],
          match: 'START',
          mode: 'ALLOW',
          path: '',
          locales: [],
          sites: []
        }
      ]
    }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)
})

/**
 * `AuthLoginPanel.vue` hands these fields to `window.location.replace()`, so a `manage:groups`
 * holder storing `javascript:...` on the administrators group would run it in the next admin's
 * session -- a bypass of the route's own `manage:system` guard.
 */
describe('PUT /:groupId — redirect field validation', () => {
  const REDIRECT_GROUP_ID = '55555555-5555-5555-5555-555555555555'
  let redirectApp: FastifyInstance
  let updateGroupCalls: Array<{ id: string; patch: Record<string, unknown> }>

  before(async () => {
    updateGroupCalls = []
    const wiki = {
      config: { security: { disallowOpenRedirect: true } },
      models: {
        groups: {
          async getGroupById(id: string) {
            return id === REDIRECT_GROUP_ID
              ? { id: REDIRECT_GROUP_ID, name: 'Editors', permissions: [], rules: [] }
              : null
          },
          async updateGroup(id: string, patch: Record<string, unknown>) {
            updateGroupCalls.push({ id, patch })
          },
          holdsSystemPermission() {
            return true
          }
        },
        auditLog: {
          async record() {}
        }
      }
    }

    redirectApp = await buildTestApp({ routes: groupsRoutes, wiki })
  })

  after(() => closeTestApp(redirectApp))

  test('rejects a javascript: redirectOnLogin with 400 and does not persist it', async () => {
    const res = await redirectApp.inject({
      method: 'PUT',
      url: `/${REDIRECT_GROUP_ID}`,
      payload: { redirectOnLogin: 'javascript:alert(1)' }
    })
    assert.equal(res.statusCode, 400)
    assert.equal(updateGroupCalls.length, 0)
  })

  test('rejects a protocol-relative //host redirectOnFirstLogin with 400', async () => {
    const res = await redirectApp.inject({
      method: 'PUT',
      url: `/${REDIRECT_GROUP_ID}`,
      payload: { redirectOnFirstLogin: '//evil.example' }
    })
    assert.equal(res.statusCode, 400)
    assert.equal(updateGroupCalls.length, 0)
  })

  test('rejects a complete https:// redirectOnLogout while disallowOpenRedirect is on', async () => {
    const res = await redirectApp.inject({
      method: 'PUT',
      url: `/${REDIRECT_GROUP_ID}`,
      payload: { redirectOnLogout: 'https://elsewhere.example/bye' }
    })
    assert.equal(res.statusCode, 400)
    assert.equal(updateGroupCalls.length, 0)
  })

  test('accepts a rooted path redirectOnLogin and persists it', async () => {
    const res = await redirectApp.inject({
      method: 'PUT',
      url: `/${REDIRECT_GROUP_ID}`,
      payload: { redirectOnLogin: '/welcome' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(updateGroupCalls.at(-1)?.patch.redirectOnLogin, '/welcome')
  })
})
