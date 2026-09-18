import assert from 'node:assert/strict'
import { after, before, describe, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import groupsRoutes from './groups.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

/**
 * Feature 357 / task 448: `Groups#clampGuestPatch` (`models/groups.ts`) strips any role outside
 * `GUEST_ROLES` from a rule written to the guests group, rather than rejecting the request — the
 * task description's explicit ask is to confirm that holds calling the real route directly
 * (`PUT /_api/groups/:groupId` — the model's own type is named `GroupPatch`, which is presumably
 * what the task description's "PATCH" refers to; there is no separate `PATCH` method on this
 * route), not just through `GroupEditOverlay.vue`, which only ever offers `GUEST_ROLES` in its
 * `<select>` in the first place and so could never exercise this path.
 *
 * DB-backed rather than a stub of `CARDINAL.models.groups`, deliberately: `clampGuestPatch` is a
 * private method of the real `Groups` class, reachable only through the real `updateGroup`, so a
 * stubbed model would prove nothing about the guard actually running. `CARDINAL.data.systemIds
 * .guestsGroupId` is pointed at the fixture group `setupTestDb()` seeds, standing in for the real
 * guests group the same way `models/groups.test.ts` already treats it as a stand-in group.
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
      // -> Stand in for the real guests group: `clampGuestPatch` only activates for whichever group
      //    id this points at.
      ;(globalThis as any).CARDINAL.data.systemIds = { guestsGroupId: fixtures.groupId }

      // -> `buildTestApp` installs the REAL `apiErrorHandler`: a thrown `CustomError` (or a
      //    `@fastify/sensible` error) carries `.statusCode`, but nothing shapes it into the
      //    `{ ok, error, statusCode, message }` `ApiError#` schema expects without it -- the
      //    default handler tries to serialize the raw `Error` object against that schema and fails,
      //    since an `Error` has no `ok`/`error` property of its own. No `wiki`: `setupTestDb()`
      //    already installed the real one, and this suite runs against it.
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

      // -> "Drop rather than refuse", per the comment on `clampGuestPatch`: the request succeeds...
      assert.equal(res.statusCode, 200)
      assert.equal(res.json().ok, true)

      // -> ...but what actually landed on the group has the disallowed roles stripped.
      const saved = await groupsModel.getGroupById(fixtures.groupId)
      assert.deepEqual(saved?.rules[0]!.roles, ['read:pages'])

      // -> And the drop was not silent.
      assert.ok(
        warn.mock.calls.length > 0,
        'expected CARDINAL.logger.warn to fire when roles are dropped'
      )
      // -> `LogFn` is `(scope, message, fields?)`: the subsystem is argument 0, the wording 1.
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

    /**
     * OpenProject #1360/#2208 (2026-08-24 security audit §2, §6): `redirectOnLogin` was a bare
     * `{ type: 'string' }` with no scheme check, and `AuthLoginPanel.vue`'s
     * `window.location.replace()` on the login path executes a `javascript:` value in the NEXT
     * signed-in user's session — including an administrator's, since the guard `clampGuestPatch`
     * above enforces protects only `manage:system` itself, not these fields.
     */
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
  }
)

/**
 * Task 2116: `PUT /:groupId` round-trips a `CLASSIFICATION` rule -- the `match` value the ajv schema
 * previously rejected with a 400 (see `api/schemas/group.test.ts` for the schema-level regression) --
 * and its `classifications` array survives the write/read cycle intact, exercising the real route +
 * model rather than the schema in isolation.
 */
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
      // -> Not the guests group: `clampGuestPatch` only clamps roles for that one group, and this test
      //    is about the `match`/`classifications` shape surviving validation, not the guest clamp.
      ;(globalThis as any).CARDINAL.data.systemIds = { guestsGroupId: 'not-this-group' }

      // -> See the sibling `describe` above: `buildTestApp` brings the real error handler and the
      //    real shared-schema set, without which `groupsRoutes`' `$ref: 'ApiError#'` responses fail
      //    to build at `app.ready()` for every route in the plugin, not just the one under test.
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
 * OpenProject #2555: `PUT /:groupId`'s body schema was tightened (commit `a3a6c799`) to validate
 * `permissions` items against the closed `GlobalPermission#` enum, but every pre-existing group --
 * and, until `models/groups.ts` was fixed alongside this test, every FRESH group too -- had
 * `PAGE_PERMISSIONS` strings (`read:pages`/`read:assets`/`read:comments`) seeded into that column.
 * The existing "single overridden field" PUT tests above never caught this because they never send
 * back a full, real group's fetched `permissions` array -- exactly what `GroupEditOverlay.vue`'s
 * `save()` used to always do. This is that missing full round trip: seed a group through the real
 * `createGroup()` path, fetch it through the real `GET /:groupId` route, then PUT the exact fetched
 * body back unchanged and confirm it no longer 400s.
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
      // -> Not the guests group -- `clampGuestPatch` only clamps roles for that one group, and this
      //    test is about the seeded `permissions` column surviving a full round trip, not the clamp.
      ;(globalThis as any).CARDINAL.data.systemIds = { guestsGroupId: 'not-this-group' }
      // -> `PUT /:groupId` reads `CARDINAL.config.auth.rootAdminGroupId` unconditionally once `patch
      //    .permissions` is present (even an empty array survives the `if (patch.permissions ...)`
      //    truthiness check below, since `[]` is truthy) -- `setupTestDb()`'s minimal CARDINAL leaves
      //    `config` as `{}`, so this must be set for the round trip below to reach that far rather
      //    than crashing on `undefined.rootAdminGroupId`.
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

      // -> Exactly what a fetch-then-resubmit-everything client would send: the whole group as it
      //    came back, nothing narrowed to only the fields that changed.
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
 * Task 472: verifies `manage:navigation`'s presence on `GET /groups` (line ~58) is exactly as broad as
 * the comment above it claims -- enough to let the navigation editor's group picker name groups by id
 * and name, but NOT enough to read a group's full permissions/rules (`GET /groups/:groupId`, which
 * still requires `read:groups` or `manage:groups`). A gap here would mean either the picker can't
 * populate (too narrow) or a nav-only account can read every group's permission grants and page rules
 * (too broad, since `GroupCore` omits both but `Group` carries them -- see `api/schemas/group.ts`).
 *
 * Same isolated-route-file approach as `navigation.test.ts`: `buildTestApp`'s `permissions: true`
 * installs the REAL global permission gate (`core/http/authHooks.ts#permissionPreHandler`), with a
 * session seeded through a test-only header ahead of it. `CARDINAL.models.groups` methods below are
 * stubbed rather than hitting a real database -- this test is about the permission surface, not
 * model behavior.
 *
 * OpenProject #3381: `GET /` no longer declares route-level `permissions` at all -- it checks
 * in-handler (`mayListGroups()`) instead, the same `No route-level permissions:` shape
 * `api/icons.ts#mayUseIconPicker` and `api/blocks.ts#mayListBlocks` use, so that a `site:approvals` or
 * `site:navigation` delegate (a SITE-scoped rule grant, invisible to `config.permissions`' group-wide
 * -only check) can still list groups for `AdminApprovals.vue`'s / `NavItemEditor`'s pickers. The stub
 * `CARDINAL.models.groups` below therefore grows `actorForRequest`/`mayHoldPermissionSomewhere` --
 * `manage:navigation`'s existing coverage stays a `permissions:true` real-hook assertion for
 * `GET /:groupId` (unchanged), but `GET /`'s own cases below now exercise the in-handler check.
 * `actorForRequest` reads the real `req.session` `session: 'header'` already seeds;
 * `mayHoldPermissionSomewhere` is a stand-in reading a second, purpose-built header
 * (`x-test-site-roles`) for the site-scoped roles a delegate holds -- `req` isn't otherwise reachable
 * from a method that, in production, takes only `(actor, permissions, siteId)`.
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
        // -> Distinct from GROUP_ID, so the root-admin-permissions guard in the PUT handler never
        //    activates for the fixture group these tests exercise.
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
        // -> Stand-in for the real `actorForRequest`: reads the same `req.session` the `session:
        //    'header'` hook below seeds from `x-test-session`/`x-test-permissions`, plus the
        //    test-only `x-test-site-roles` header `mayHoldPermissionSomewhere` below consults.
        actorForRequest(req: any) {
          const header = req.headers['x-test-site-roles']
          return {
            groupIds: [],
            permissions: req.session?.authenticated ? (req.session.permissions ?? []) : [],
            testSiteRoles: typeof header === 'string' ? header.split(',').filter(Boolean) : []
          }
        },
        // -> Stand-in for the real `mayHoldPermissionSomewhere(actor, permissions, siteId)`: the
        //    route calls it site-blind (`siteId: null`), so this ignores the third argument and just
        //    checks whether any of `permissions` is among the site-scoped roles `actorForRequest`
        //    above attached to the actor.
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

/**
 * `siteRoles` feeds the stub `mayHoldPermissionSomewhere` above via `x-test-site-roles`, standing in
 * for a `site:approvals`/`site:navigation` grant that lives on a site-scoped rule rather than the
 * group-wide `permissions` list `permissions` (the first argument) seeds.
 */
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

/**
 * OpenProject #3381: `manage:sites` is folded into `mayListGroups()`'s global-permission fast path
 * (not left to the `site:approvals`/`site:navigation` fallback), so a full site administrator lists
 * groups everywhere rather than only where a rule happens to grant one of those two names.
 */
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

/**
 * The bug this work package fixes: a `site:approvals` delegate holds no global permission at all
 * (`AdminApprovals.vue`'s own `Promise.all` groups load), so before this fix `GET /` refused them and
 * the approval-rule group pickers rendered empty.
 */
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

/** Same shape, for `NavItemEditor`'s visibility picker and its `site:navigation` delegate. */
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
 * `GET /` declares no route-level `permissions` (OpenProject #3381), so the real
 * `permissionPreHandler` never runs for it and can't 401 an anonymous caller the way it does for
 * `GET /:groupId` below. `mayListGroups()`'s in-handler check can't distinguish "no session" from
 * "a session with no relevant grant" either -- the same tradeoff `api/icons.ts#mayUseIconPicker` and
 * `api/blocks.ts#mayListBlocks` already accept for their own picker routes. This is a deliberate,
 * precedented behavior change from 401 to 403, not a regression.
 */
test('an anonymous request is refused the list, with 403 rather than 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/' })
  assert.equal(res.statusCode, 403)
})

/**
 * OpenProject #1658: `permissions` and rule `roles` are now validated against the closed
 * vocabularies (`helpers/permissions.ts`, `helpers/siteRules.ts`) at the schema level, so an unknown
 * string is rejected with 400 before it ever reaches `updateGroup` -- rather than being silently
 * accepted, stored, and granting nothing. Schema validation runs ahead of the permission preHandler
 * in Fastify's request lifecycle, but `manage:groups` headers are still sent here to keep each case
 * indistinguishable from a real, otherwise-authorized caller.
 *
 * There is no equivalent case for the create route: `POST /groups` accepts only `name` in its body
 * (`createGroup` seeds default permissions/rules internally, not from caller input), so it has no
 * `permissions`/`roles` surface for an unknown vocabulary entry to reach in the first place.
 *
 * Placed before the redirect-field-validation describe block below: that block's own `after()` tears
 * down the ambient `globalThis.CARDINAL` its isolated `redirectApp` needs, and these three cases run
 * against the file's own top-level `app`/`CARDINAL` instead -- ordered after that teardown, they would
 * find `CARDINAL` gone.
 */
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
 * OpenProject #2208 §2: `redirectOnLogin`/`redirectOnFirstLogin`/`redirectOnLogout` used to be
 * copied into the patch with no validation at all, so a `manage:groups` holder could store
 * `javascript:...` on the administrators group and have it execute for the next admin who signs in
 * -- with no click required, and a complete bypass of `api/groups.ts`'s own `manage:system` guard,
 * whose entire purpose is to stop `manage:groups` reaching that permission. Isolated route-file
 * approach, same as the permission-surface suite above: `CARDINAL.models.groups` stubbed rather than a
 * real database, since this is about the route's own validation rather than model behavior.
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
