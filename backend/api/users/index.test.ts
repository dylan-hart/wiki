import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import usersRoutes from './index.ts'
import { createSilentLogger } from '../../test/mocks.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

let app: FastifyInstance

/**
 * Mutable fixtures: a test sets them ahead of its own `app.inject` and restores them in a
 * `finally`. The `test()` calls here run sequentially, so shared module state is safe only as long
 * as every test cleans up after itself.
 */
let siteFeatures: Record<string, any> | null = null
let userGroupsFixture: Array<{ id: string; name: string }> = []
let nonMemberGroupsFixture: Array<{ id: string; name: string }> = []

const KNOWN_GROUP_ID = '55555555-5555-5555-5555-555555555555'
const UNKNOWN_GROUP_ID = '66666666-6666-6666-6666-666666666666'
const EXISTING_USER_ID = '77777777-7777-7777-7777-777777777777'
let knownGroupsFixture: Array<{ id: string }> = [{ id: KNOWN_GROUP_ID }]
let createUserCalls: Array<Record<string, any>> = []
let setUserGroupsCalls: string[][] = []

let deleteUserFixture: { id: string; email: string; isSystem: boolean } | null = null
let deleteUserError: Error | null = null
const deleteUserWarnCalls: any[] = []

let profileFixtures: Record<string, Record<string, any> | null> = {}

before(async () => {
  const wiki = {
    config: {
      auth: { rootAdminGroupId: '88888888-8888-8888-8888-888888888888' }
    },
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
        getById: async (id: string) =>
          deleteUserFixture ?? { id, email: 'existing@example.com', isSystem: false },
        getUserGroupIds: async () => [],
        updateUser: async () => {},
        setUserGroups: async (_userId: string, groupIds: string[]) => {
          setUserGroupsCalls.push(groupIds)
        },
        setUserAuthFlags: async () => {},
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
        },
        getProfile: async (id: string) => profileFixtures[id] ?? null
      },
      groups: {
        hasUnknownGroupIds: async (ids: string[]) =>
          ids.some((id) => !knownGroupsFixture.some((g) => g.id === id)),
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

  app = await buildTestApp({ routes: usersRoutes, swagger: true, session: 'header', wiki })
})

after(() => closeTestApp(app))

test('GET /whoami documents a concrete 200 response schema', () => {
  const doc: any = app.swagger()
  const responseSchema =
    doc.paths['/whoami'].get.responses['200'].content['application/json'].schema
  // -> Walks `$ref` and `allOf`, so this holds however the route composes the shape.
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
  const userId = '11111111-1111-1111-1111-111111111111'
  const session = {
    authenticated: true,
    user: {
      id: userId,
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
  // -> The row agrees with the session snapshot here; the staleness test below tells them apart.
  profileFixtures = {
    [userId]: {
      timezone: session.user.timezone,
      dateFormat: session.user.dateFormat,
      timeFormat: session.user.timeFormat,
      appearance: session.user.appearance,
      aesthetic: 'site',
      contentWidth: 'site',
      cvd: session.user.cvd,
      locale: ''
    }
  }
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { 'x-test-session': JSON.stringify(session) }
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), {
      authenticated: true,
      ...session.user,
      aesthetic: 'site',
      contentWidth: 'site',
      locale: '',
      permissions: session.permissions
    })
  } finally {
    profileFixtures = {}
  }
})

test('GET /whoami sources prefs fresh from the database rather than the session snapshot', async () => {
  const userId = '22222222-2222-2222-2222-222222222222'
  const session = {
    authenticated: true,
    user: {
      id: userId,
      email: 'bob@example.com',
      name: 'Bob',
      hasAvatar: false,
      // -> The session's own stale snapshot, from this session's login.
      timezone: 'America/New_York',
      dateFormat: 'YYYY-MM-DD',
      timeFormat: '12h',
      appearance: 'light',
      aesthetic: 'site',
      contentWidth: 'site',
      cvd: 'none',
      locale: ''
    },
    permissions: []
  }
  // -> What another session saved since, now the row's real value.
  profileFixtures = {
    [userId]: {
      timezone: 'Europe/Berlin',
      dateFormat: 'DD/MM/YYYY',
      timeFormat: '24h',
      appearance: 'dark',
      aesthetic: 'sunset',
      contentWidth: 'full',
      cvd: 'protanopia',
      locale: 'de'
    }
  }
  try {
    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { 'x-test-session': JSON.stringify(session) }
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    // -> Not profile preferences: these are still served from the session.
    assert.equal(body.id, userId)
    assert.equal(body.email, session.user.email)
    assert.equal(body.name, session.user.name)
    assert.equal(body.hasAvatar, session.user.hasAvatar)
    assert.equal(body.timezone, 'Europe/Berlin')
    assert.equal(body.dateFormat, 'DD/MM/YYYY')
    assert.equal(body.timeFormat, '24h')
    assert.equal(body.appearance, 'dark')
    assert.equal(body.aesthetic, 'sunset')
    assert.equal(body.contentWidth, 'full')
    assert.equal(body.cvd, 'protanopia')
    assert.equal(body.locale, 'de')
  } finally {
    profileFixtures = {}
  }
})

test('GET /whoami falls back to the session snapshot when the account row is gone', async () => {
  const userId = '33333333-3333-3333-3333-333333333333'
  const session = {
    authenticated: true,
    user: {
      id: userId,
      email: 'carol@example.com',
      name: 'Carol',
      appearance: 'dark',
      aesthetic: 'site'
    },
    permissions: []
  }
  profileFixtures = { [userId]: null }
  try {
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
  } finally {
    profileFixtures = {}
  }
})

/**
 * `GET /profile/groups` resolves the site from the request's hostname, so every case below sends a
 * `host` header.
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
 * `setUserGroups` silently drops a group id that names no real group, so these two routes have to
 * refuse one themselves.
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
