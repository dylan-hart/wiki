import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import usersRoutes from './index.ts'
import { groups } from '../../models/groups.ts'
import { buildTestApp, closeTestApp, TEST_PERMISSIONS_HEADER } from '../../test/fastify.ts'

const ROOT_ADMIN_GROUP = '88888888-8888-4888-8888-888888888888'
const SYSTEM_GROUP = '11111111-1111-4111-8111-111111111111'
const GROUPS_GROUP = '22222222-2222-4222-8222-222222222222'
const USERS_GROUP = '33333333-3333-4333-8333-333333333333'
const PLAIN_GROUP = '44444444-4444-4444-8444-444444444444'
const TARGET_USER = '55555555-5555-4555-8555-555555555555'
const NEW_USER = '66666666-6666-4666-8666-666666666666'

const GROUP_PERMISSIONS: Record<string, string[]> = {
  [SYSTEM_GROUP]: ['manage:system'],
  [GROUPS_GROUP]: ['manage:groups'],
  [USERS_GROUP]: ['manage:users'],
  [PLAIN_GROUP]: ['manage:theme'],
  [ROOT_ADMIN_GROUP]: []
}

let app: FastifyInstance
let currentGroups: string[]
let createUserCalls: any[]
let applyUserUpdateCalls: any[]

/**
 * The real `Groups` methods over a faked table read, so the guard under test is the production one
 * and only the two group-id lookups are stubbed.
 */
function groupsModel() {
  const model: any = Object.create(groups)
  const idsCarrying = (wanted: string[]) => [
    ...Object.entries(GROUP_PERMISSIONS)
      .filter(([, permissions]) => wanted.some((p) => permissions.includes(p)))
      .map(([id]) => id),
    ROOT_ADMIN_GROUP
  ]
  model.hasUnknownGroupIds = async () => false
  model.userHoldsSystemPermission = async () => false
  model.isUserInGroup = async () => false
  model.countUsersInGroup = async () => 2
  model.systemGroupIds = async () => idsCarrying(['manage:system'])
  model.elevatedGroupIds = async () =>
    idsCarrying(['manage:users', 'manage:groups', 'manage:system'])
  return model
}

before(async () => {
  const wiki = {
    config: { auth: { rootAdminGroupId: ROOT_ADMIN_GROUP } },
    data: { systemIds: { localAuthId: 'local', guestsGroupId: 'guests' } },
    models: {
      users: {
        getByEmail: async () => null,
        getById: async () => ({ id: TARGET_USER, email: 'target@example.com', isSystem: false }),
        getUserGroupIds: async () => currentGroups,
        createUser: async (args: any) => {
          createUserCalls.push(args)
          return NEW_USER
        },
        applyUserUpdate: async (id: string, args: any) => {
          applyUserUpdateCalls.push({ id, groups: args.groups })
        }
      },
      groups: groupsModel(),
      auditLog: { record: async () => {} },
      mail: { isConfigured: () => false }
    }
  }
  app = await buildTestApp({ routes: usersRoutes, wiki, session: 'header', ajv: true })
})

after(() => closeTestApp(app))

beforeEach(() => {
  currentGroups = [PLAIN_GROUP]
  createUserCalls = []
  applyUserUpdateCalls = []
})

const create = (permissions: string[], groupIds: string[]) =>
  app.inject({
    method: 'POST',
    url: '/',
    headers: { [TEST_PERMISSIONS_HEADER]: permissions.join(',') },
    payload: {
      name: 'New Person',
      email: 'new@example.com',
      password: 'a-long-password',
      groups: groupIds
    }
  })

const update = (permissions: string[], groupIds: string[]) =>
  app.inject({
    method: 'PUT',
    url: `/${TARGET_USER}`,
    headers: { [TEST_PERMISSIONS_HEADER]: permissions.join(',') },
    payload: { groups: groupIds }
  })

describe('POST /users: creating an account inside an elevated group', () => {
  test('a manage:users-only holder cannot create a user inside a manage:system group', async () => {
    const res = await create(['manage:users'], [SYSTEM_GROUP])

    assert.equal(res.statusCode, 403)
    assert.equal(res.json().error, 'groupMembershipSystemProtected')
    assert.equal(createUserCalls.length, 0)
  })

  test('a manage:users-only holder cannot create a user inside the root administrators group', async () => {
    const res = await create(['manage:users'], [ROOT_ADMIN_GROUP])

    assert.equal(res.statusCode, 403)
    assert.equal(createUserCalls.length, 0)
  })

  for (const [label, group] of [
    ['manage:groups', GROUPS_GROUP],
    ['manage:users', USERS_GROUP]
  ] as const) {
    test(`a manage:users-only holder cannot create a user inside a ${label} group`, async () => {
      const res = await create(['manage:users'], [PLAIN_GROUP, group])

      assert.equal(res.statusCode, 403)
      assert.equal(res.json().error, 'groupMembershipElevatedProtected')
      assert.equal(createUserCalls.length, 0)
    })
  }

  test('a manage:users-only holder can still create a user in an ordinary group', async () => {
    const res = await create(['manage:users'], [PLAIN_GROUP])

    assert.equal(res.statusCode, 200)
    assert.deepEqual(createUserCalls[0].groups, [PLAIN_GROUP])
  })

  test('a manage:users-only holder can still create a user in no group', async () => {
    const res = await create(['manage:users'], [])

    assert.equal(res.statusCode, 200)
  })

  test('a manage:groups holder may create a user inside a group carrying manage:users', async () => {
    const res = await create(['manage:users', 'manage:groups'], [USERS_GROUP])

    assert.equal(res.statusCode, 200)
  })

  test('a manage:groups holder still cannot create a user inside a manage:system group', async () => {
    const res = await create(['manage:users', 'manage:groups'], [SYSTEM_GROUP])

    assert.equal(res.statusCode, 403)
    assert.equal(res.json().error, 'groupMembershipSystemProtected')
    assert.equal(createUserCalls.length, 0)
  })

  test('a manage:system holder may create a user inside a manage:system group', async () => {
    const res = await create(['manage:system'], [SYSTEM_GROUP])

    assert.equal(res.statusCode, 200)
  })
})

describe('PUT /users/:userId: manage:users -> manage:groups', () => {
  test('a manage:users-only holder cannot join a group carrying manage:groups', async () => {
    const res = await update(['manage:users'], [PLAIN_GROUP, GROUPS_GROUP])

    assert.equal(res.statusCode, 403)
    assert.equal(res.json().error, 'groupMembershipElevatedProtected')
    assert.equal(applyUserUpdateCalls.length, 0)
  })

  test('a manage:users-only holder cannot join a group carrying manage:users', async () => {
    const res = await update(['manage:users'], [PLAIN_GROUP, USERS_GROUP])

    assert.equal(res.statusCode, 403)
    assert.equal(applyUserUpdateCalls.length, 0)
  })

  test('a manage:users-only holder cannot join a manage:system group', async () => {
    const res = await update(['manage:users'], [PLAIN_GROUP, SYSTEM_GROUP])

    assert.equal(res.statusCode, 403)
    assert.equal(res.json().error, 'groupMembershipSystemProtected')
    assert.equal(applyUserUpdateCalls.length, 0)
  })

  test('a manage:users-only holder cannot REMOVE a user from an elevated group', async () => {
    currentGroups = [PLAIN_GROUP, GROUPS_GROUP]

    const res = await update(['manage:users'], [PLAIN_GROUP])

    assert.equal(res.statusCode, 403)
    assert.equal(res.json().error, 'groupMembershipElevatedProtected')
    assert.equal(applyUserUpdateCalls.length, 0)
  })

  test('resending an unchanged membership that includes an elevated group is allowed', async () => {
    currentGroups = [PLAIN_GROUP, GROUPS_GROUP]

    const res = await update(['manage:users'], [GROUPS_GROUP, PLAIN_GROUP])

    assert.equal(res.statusCode, 200)
    assert.equal(applyUserUpdateCalls.length, 1)
  })

  test('changing only ordinary groups is allowed while an elevated one is untouched', async () => {
    currentGroups = [GROUPS_GROUP]

    const res = await update(['manage:users'], [GROUPS_GROUP, PLAIN_GROUP])

    assert.equal(res.statusCode, 200)
  })
})

describe('the by-design remainder: manage:groups is everything short of manage:system', () => {
  test('a manage:groups holder may add a user to a group carrying manage:users (the manage:groups -> manage:users step)', async () => {
    const res = await update(['manage:users', 'manage:groups'], [PLAIN_GROUP, USERS_GROUP])

    assert.equal(res.statusCode, 200)
    assert.deepEqual(applyUserUpdateCalls[0].groups, [PLAIN_GROUP, USERS_GROUP])
  })

  test('and may remove a user from one', async () => {
    currentGroups = [PLAIN_GROUP, GROUPS_GROUP]

    const res = await update(['manage:users', 'manage:groups'], [PLAIN_GROUP])

    assert.equal(res.statusCode, 200)
  })

  test('but still cannot add a user to a manage:system group', async () => {
    const res = await update(['manage:users', 'manage:groups'], [PLAIN_GROUP, SYSTEM_GROUP])

    assert.equal(res.statusCode, 403)
    assert.equal(res.json().error, 'groupMembershipSystemProtected')
  })

  test('a manage:system holder may add a user to a manage:system group', async () => {
    const res = await update(['manage:system'], [PLAIN_GROUP, SYSTEM_GROUP])

    assert.equal(res.statusCode, 200)
  })
})
