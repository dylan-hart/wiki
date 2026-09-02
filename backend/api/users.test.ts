import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import usersRoutes from './users.ts'
import { createSilentLogger } from '../test/mocks.ts'
import { buildTestApp, closeTestApp } from '../test/fastify.ts'

/**
 * Regression test for the `GET /whoami` response schema gap: with no `response` block, the generated
 * OpenAPI document has no concrete schema for the 200 response. `whoAmI()` (the handler, exported from
 * `./users.ts`) returns `{ authenticated: false }` for a guest, and the session's profile fields plus
 * `permissions` for a logged in user, so both shapes are exercised here via `app.inject`'s `session`.
 */

let app: FastifyInstance

/**
 * Mutable fixtures for `GET /profile/groups` (task 1274): each test sets these ahead of its own
 * `app.inject`, then restores them in a `finally` -- `test()` calls in this file run sequentially, so
 * shared module state is safe as long as every test cleans up after itself rather than assuming the
 * next one will reset it.
 */
let siteFeatures: Record<string, any> | null = null
let userGroupsFixture: Array<{ id: string; name: string }> = []
let nonMemberGroupsFixture: Array<{ id: string; name: string }> = []

/**
 * Fixtures for the OpenProject #1603 group-validation tests: `knownGroupsFixture` is what
 * `WIKI.models.groups.hasUnknownGroupIds()` answers against, and the two call-log arrays let a test
 * assert that an unknown group id short-circuits before either write path (`createUser` /
 * `setUserGroups`) runs.
 */
const KNOWN_GROUP_ID = '55555555-5555-5555-5555-555555555555'
const UNKNOWN_GROUP_ID = '66666666-6666-6666-6666-666666666666'
const EXISTING_USER_ID = '77777777-7777-7777-7777-777777777777'
let knownGroupsFixture: Array<{ id: string }> = [{ id: KNOWN_GROUP_ID }]
let createUserCalls: Array<Record<string, any>> = []
let setUserGroupsCalls: string[][] = []

/**
 * Mutable fixtures for `DELETE /:userId` (task 2283): each test sets these ahead of its own
 * `app.inject`, then restores them in a `finally` -- same convention as the `/profile/groups`
 * fixtures above.
 */
let deleteUserFixture: { id: string; email: string; isSystem: boolean } | null = null
let deleteUserError: Error | null = null
const deleteUserWarnCalls: any[] = []

before(async () => {
  const wiki = {
    config: {
      auth: { rootAdminGroupId: '88888888-8888-8888-8888-888888888888' }
    },
    // -> Not the silent default: one test asserts on what the DELETE route logged.
    logger: {
      ...createSilentLogger(),
      warn: (err: any) => {
        deleteUserWarnCalls.push(err)
      }
    },
    models: {
      users: {
        getUserGroups: async () => userGroupsFixture,
        getNonMemberGroups: async () => nonMemberGroupsFixture,
        getByEmail: async () => null,
        createUser: async (input: Record<string, any>) => {
          createUserCalls.push(input)
          return 'new-user-id'
        },
        // -> Serves both the group-validation tests (which look up `EXISTING_USER_ID` and expect a
        //    generic existing user back) and the `DELETE /:userId` tests (which set
        //    `deleteUserFixture` ahead of the call and expect that exact object back).
        getById: async (id: string) =>
          deleteUserFixture ?? { id, email: 'existing@example.com', isSystem: false },
        getUserGroupIds: async () => [],
        updateUser: async () => {},
        setUserGroups: async (_userId: string, groupIds: string[]) => {
          setUserGroupsCalls.push(groupIds)
        },
        setUserAuthFlags: async () => {},
        // -> `PUT /:userId` calls this instead of `updateUser`/`setUserGroups`/`setUserAuthFlags`
        //    individually (OpenProject #1609's atomicity work) -- mirror that here so `groups` still
        //    lands in `setUserGroupsCalls` the way these tests assert on.
        applyUserUpdate: async (
          _id: string,
          { groups }: { patch?: Record<string, any>; groups?: string[]; authFlags?: unknown }
        ) => {
          if (groups !== undefined) {
            setUserGroupsCalls.push(groups)
          }
        },
        deleteUser: async () => {
          if (deleteUserError) throw deleteUserError
          return true
        }
      },
      groups: {
        hasUnknownGroupIds: async (ids: string[]) =>
          ids.some((id) => !knownGroupsFixture.some((g) => g.id === id)),
        // -> Happy path for every test that doesn't care about the system-user guard: the caller
        //    already holds `manage:system`, so `systemUserGuard` returns immediately.
        holdsSystemPermission: () => true,
        userHoldsSystemPermission: async () => false,
        systemGroupIds: async () => [],
        isUserInGroup: async () => false,
        countUsersInGroup: async () => 0
      },
      mail: {
        isConfigured: () => false
      },
      sites: {
        getSiteByHostname: async () =>
          siteFeatures ? { config: { features: siteFeatures } } : null
      },
      auditLog: {
        record: async () => {}
      },
      sessions: {
        clearSessionsFromUser: async () => {}
      }
    }
  }

  // -> Fastify session support isn't registered in this minimal harness; `req.session` is seeded
  //    from `x-test-session` instead, which is all `whoAmI()` reads.
  app = await buildTestApp({ routes: usersRoutes, swagger: true, session: 'header', wiki })
})

after(() => closeTestApp(app))

test('GET /whoami documents a concrete 200 response schema', () => {
  const doc: any = app.swagger()
  const responseSchema =
    doc.paths['/whoami'].get.responses['200'].content['application/json'].schema
  // -> Merged into one schema (rather than a bare `allOf`) once `$ref`s are resolved against
  //    `components.schemas`, so this holds regardless of whether the route composes the shape via
  //    `allOf`, `$ref`, or an inline object.
  const properties = new Set<string>()
  const collect = (schema: any) => {
    if (schema.$ref) {
      const name = schema.$ref.replace('#/components/schemas/', '')
      collect(doc.components.schemas[name])
      return
    }
    if (schema.properties) {
      for (const key of Object.keys(schema.properties)) properties.add(key)
    }
    for (const sub of schema.allOf ?? []) collect(sub)
  }
  collect(responseSchema)
  assert.ok(properties.has('authenticated'))
  assert.ok(properties.has('permissions'))
  assert.ok(properties.has('id'))
  assert.ok(properties.has('email'))
  assert.ok(properties.has('name'))
})

test('GET /whoami serializes the guest shape', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/whoami',
    headers: { 'x-test-session': JSON.stringify({ authenticated: false }) }
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { authenticated: false })
})

test('GET /whoami serializes the logged in shape, permissions included', async () => {
  const session = {
    authenticated: true,
    user: {
      id: '11111111-1111-1111-1111-111111111111',
      email: 'alice@example.com',
      name: 'Alice',
      hasAvatar: true,
      timezone: 'America/New_York',
      dateFormat: 'YYYY-MM-DD',
      timeFormat: '24h',
      appearance: 'dark',
      cvd: 'none'
    },
    permissions: ['read:pages', 'write:pages']
  }
  const res = await app.inject({
    method: 'GET',
    url: '/whoami',
    headers: { 'x-test-session': JSON.stringify(session) }
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), {
    authenticated: true,
    ...session.user,
    permissions: session.permissions
  })
})

/**
 * `GET /profile/groups` (task 1274): the response is gated on the caller's site having
 * `features.showOtherGroups` enabled -- off, the shape is exactly the pre-existing plain array; on, it
 * also names the groups the caller is NOT a member of. The route resolves the site from the request's
 * hostname the same way `isProfileEditable` does, so every case below sends a `host` header.
 */

const GROUPS_SESSION = JSON.stringify({
  authenticated: true,
  user: { id: '11111111-1111-1111-1111-111111111111' }
})

test('GET /profile/groups: setting off -> unchanged response shape (plain array)', async () => {
  siteFeatures = { showOtherGroups: false }
  userGroupsFixture = [{ id: '33333333-3333-3333-3333-333333333333', name: 'Editors' }]
  nonMemberGroupsFixture = [{ id: '44444444-4444-4444-4444-444444444444', name: 'Reviewers' }]
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/profile/groups',
      headers: { host: 'wiki.example.com', 'x-test-session': GROUPS_SESSION }
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), [{ id: '33333333-3333-3333-3333-333333333333', name: 'Editors' }])
  } finally {
    siteFeatures = null
    userGroupsFixture = []
    nonMemberGroupsFixture = []
  }
})

test('GET /profile/groups: setting on -> non-member groups included', async () => {
  siteFeatures = { showOtherGroups: true }
  userGroupsFixture = [{ id: '33333333-3333-3333-3333-333333333333', name: 'Editors' }]
  nonMemberGroupsFixture = [{ id: '44444444-4444-4444-4444-444444444444', name: 'Reviewers' }]
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/profile/groups',
      headers: { host: 'wiki.example.com', 'x-test-session': GROUPS_SESSION }
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), {
      groups: [{ id: '33333333-3333-3333-3333-333333333333', name: 'Editors' }],
      otherGroups: [{ id: '44444444-4444-4444-4444-444444444444', name: 'Reviewers' }]
    })
  } finally {
    siteFeatures = null
    userGroupsFixture = []
    nonMemberGroupsFixture = []
  }
})

test('GET /profile/groups: setting on, member of every group -> empty non-member list', async () => {
  siteFeatures = { showOtherGroups: true }
  userGroupsFixture = [
    { id: '33333333-3333-3333-3333-333333333333', name: 'Editors' },
    { id: '44444444-4444-4444-4444-444444444444', name: 'Reviewers' }
  ]
  nonMemberGroupsFixture = []
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/profile/groups',
      headers: { host: 'wiki.example.com', 'x-test-session': GROUPS_SESSION }
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), {
      groups: userGroupsFixture,
      otherGroups: []
    })
  } finally {
    siteFeatures = null
    userGroupsFixture = []
    nonMemberGroupsFixture = []
  }
})

/**
 * OpenProject #1603: `POST /users` and `PUT /users/:userId` must reject a group id that names no
 * real group, rather than handing it to `setUserGroups` (`models/users.ts`) and having it silently
 * dropped -- see that model method's own leniency comment for why the model layer stays lenient
 * while these two route handlers do not.
 */

test('POST /: rejects an unknown group id, without creating the user', async () => {
  createUserCalls = []
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: {
      name: 'Jane Doe',
      email: 'jane@example.com',
      password: 'a-long-password',
      groups: [KNOWN_GROUP_ID, UNKNOWN_GROUP_ID]
    }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().message, 'ERR_UNKNOWN_GROUPS')
  assert.equal(createUserCalls.length, 0)
})

test('POST /: a fully-known group list is accepted', async () => {
  createUserCalls = []
  const res = await app.inject({
    method: 'POST',
    url: '/',
    payload: {
      name: 'Jane Doe',
      email: 'jane@example.com',
      password: 'a-long-password',
      groups: [KNOWN_GROUP_ID]
    }
  })
  assert.equal(res.statusCode, 200)
  assert.equal(createUserCalls.length, 1)
})

test('PUT /:userId: rejects an unknown group id, without changing membership', async () => {
  setUserGroupsCalls = []
  const res = await app.inject({
    method: 'PUT',
    url: `/${EXISTING_USER_ID}`,
    payload: { groups: [UNKNOWN_GROUP_ID] }
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().message, 'ERR_UNKNOWN_GROUPS')
  assert.equal(setUserGroupsCalls.length, 0)
})

test('PUT /:userId: a fully-known group list is accepted', async () => {
  setUserGroupsCalls = []
  const res = await app.inject({
    method: 'PUT',
    url: `/${EXISTING_USER_ID}`,
    payload: { groups: [KNOWN_GROUP_ID] }
  })
  assert.equal(res.statusCode, 200)
  assert.deepEqual(setUserGroupsCalls, [[KNOWN_GROUP_ID]])
})

/**
 * `DELETE /:userId` (task 2283): a `23503` foreign key violation on delete should name the actual
 * blocking relation, read off the Postgres constraint name, rather than a hard-coded "pages or
 * assets" guess -- and the reassign advice should only be offered where reassigning is the real
 * remedy.
 */

const DELETE_ADMIN_SESSION = JSON.stringify({
  authenticated: true,
  user: { id: '22222222-2222-2222-2222-222222222222', name: 'Admin' }
})

const TARGET_USER = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'target@example.com',
  isSystem: false
}

test('DELETE /:userId: unrecognized 23503 constraint falls back to the generic pages/assets message', async () => {
  deleteUserFixture = TARGET_USER
  deleteUserError = new Error('violates foreign key constraint')
  ;(deleteUserError as any).cause = { code: '23503', constraint: 'some_other_table_fkey' }
  try {
    const res = await app.inject({
      method: 'DELETE',
      url: `/${TARGET_USER.id}`,
      headers: { 'x-test-session': DELETE_ADMIN_SESSION }
    })
    assert.equal(res.statusCode, 409)
    assert.match(res.json().message, /Cannot delete a user who still owns pages or assets/)
  } finally {
    deleteUserFixture = null
    deleteUserError = null
  }
})

test('DELETE /:userId: pages_authorId constraint names authored pages and advises reassigning', async () => {
  deleteUserFixture = TARGET_USER
  deleteUserError = new Error('violates foreign key constraint')
  ;(deleteUserError as any).cause = { code: '23503', constraint: 'pages_authorId_users_id_fkey' }
  try {
    const res = await app.inject({
      method: 'DELETE',
      url: `/${TARGET_USER.id}`,
      headers: { 'x-test-session': DELETE_ADMIN_SESSION }
    })
    assert.equal(res.statusCode, 409)
    assert.equal(
      res.json().message,
      'Cannot delete a user who still has authored pages. Reassign them first.'
    )
  } finally {
    deleteUserFixture = null
    deleteUserError = null
  }
})

test('DELETE /:userId: pageEditSubmissions_authorId constraint names the open suggestion, no reassign advice', async () => {
  deleteUserFixture = TARGET_USER
  deleteUserError = new Error('violates foreign key constraint')
  ;(deleteUserError as any).cause = {
    code: '23503',
    constraint: 'pageEditSubmissions_authorId_users_id_fkey'
  }
  try {
    const res = await app.inject({
      method: 'DELETE',
      url: `/${TARGET_USER.id}`,
      headers: { 'x-test-session': DELETE_ADMIN_SESSION }
    })
    assert.equal(res.statusCode, 409)
    assert.equal(
      res.json().message,
      'Cannot delete a user who still has an open page edit suggestion. Approve or reject it first.'
    )
  } finally {
    deleteUserFixture = null
    deleteUserError = null
  }
})
