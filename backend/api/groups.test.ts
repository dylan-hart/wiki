import assert from 'node:assert/strict'
import { after, before, describe, mock, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fastifySensible from '@fastify/sensible'
import ajvFormats from 'ajv-formats'
import groupsRoutes from './groups.ts'
import { registerSchemas as registerGroupSchema } from './schemas/group.ts'
import { registerSchemas as registerUserSchema } from './schemas/user.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'

/**
 * Feature 357 / task 448: `Groups#clampGuestPatch` (`models/groups.ts`) strips any role outside
 * `GUEST_ROLES` from a rule written to the guests group, rather than rejecting the request — the
 * task description's explicit ask is to confirm that holds calling the real route directly
 * (`PUT /_api/groups/:groupId` — the model's own type is named `GroupPatch`, which is presumably
 * what the task description's "PATCH" refers to; there is no separate `PATCH` method on this
 * route), not just through `GroupEditOverlay.vue`, which only ever offers `GUEST_ROLES` in its
 * `<select>` in the first place and so could never exercise this path.
 *
 * DB-backed rather than a stub of `WIKI.models.groups`, deliberately: `clampGuestPatch` is a
 * private method of the real `Groups` class, reachable only through the real `updateGroup`, so a
 * stubbed model would prove nothing about the guard actually running. `WIKI.data.systemIds
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
      ;(globalThis as any).WIKI.data.systemIds = { guestsGroupId: fixtures.groupId }

      app = fastify({
        ajv: {
          plugins: [[ajvFormats.default, {}] as any]
        }
      })
      await app.register(fastifySensible)
      await registerUserSchema(app)
      await registerGroupSchema(app)
      await app.register(groupsRoutes)
      await app.ready()
    })

    after(async () => {
      await app.close()
      await teardownTestDb()
    })

    test('drops a disallowed role rather than rejecting the request', async () => {
      const warn = mock.method(WIKI.logger, 'warn')

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
        'expected WIKI.logger.warn to fire when roles are dropped'
      )
      assert.match(warn.mock.calls[0]!.arguments[0] as string, /dropped/i)

      warn.mock.restore()
    })

    test('a patch with only already-allowed roles does not warn', async () => {
      const warn = mock.method(WIKI.logger, 'warn')

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
 * Same isolated-route-file approach as `navigation.test.ts`: the real permission gate is `index.ts`'s
 * single global `preHandler` hook, reproduced verbatim here, with a session seeded through a
 * test-only header ahead of it. `WIKI.models.groups` methods below are stubbed rather than hitting a
 * real database -- this test is about the permission surface, not model behavior.
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
  ;(globalThis as any).WIKI = {
    config: {
      auth: {
        // -> Distinct from GROUP_ID, so the root-admin-permissions guard in the PUT handler never
        //    activates for the fixture group these tests exercise.
        rootAdminGroupId: '99999999-9999-9999-9999-999999999999'
      }
    },
    logger: {
      warn: () => {}
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

  app = fastify()
  await app.register(fastifySensible)
  // -> Mirrors `index.ts`'s real `setErrorHandler`: a `reply.forbidden()`/`unauthorized()`/etc. is a
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
  await registerGroupSchema(app)
  await registerUserSchema(app)
  await registerErrorSchema(app)
  app.addHook('onRequest', testSessionOnRequest)
  app.addHook('preHandler', permissionPreHandler)
  await app.register(groupsRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

function headersFor(permissions: string[]) {
  return {
    'x-test-session': JSON.stringify({ authenticated: true, permissions, groups: [] })
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

test('an account with neither read:groups, manage:groups nor manage:navigation is refused the list', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/',
    headers: headersFor(['write:pages'])
  })
  assert.equal(res.statusCode, 403)
})

test('an anonymous request is refused the list', async () => {
  const res = await app.inject({ method: 'GET', url: '/' })
  assert.equal(res.statusCode, 401)
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
