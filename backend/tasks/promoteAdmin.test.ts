import assert from 'node:assert/strict'
import { describe, mock, test } from 'node:test'
import { parsePromoteAdminArgs, promoteUserToAdmin } from './promoteAdmin.ts'
import type { PromoteAdminWiki } from './promoteAdmin.ts'

const ADMIN_GROUP_ID = 'admin-group-id'

function makeWiki(overrides: {
  getByEmail?: any
  isUserInGroup?: any
  getUserGroupIds?: any
  setUserGroups?: any
}): PromoteAdminWiki {
  return {
    config: { auth: { rootAdminGroupId: ADMIN_GROUP_ID } },
    models: {
      users: {
        getByEmail: overrides.getByEmail ?? mock.fn(async () => null),
        getUserGroupIds: overrides.getUserGroupIds ?? mock.fn(async () => []),
        setUserGroups: overrides.setUserGroups ?? mock.fn(async () => {})
      },
      groups: {
        isUserInGroup: overrides.isUserInGroup ?? mock.fn(async () => false)
      }
    }
  } as unknown as PromoteAdminWiki
}

describe('parsePromoteAdminArgs', () => {
  test('parses --email, lowercased and trimmed', () => {
    const args = parsePromoteAdminArgs(['--email', '  Admin@Example.com  '])
    assert.equal(args.email, 'admin@example.com')
  })

  test('throws a plain Error when --email is missing', () => {
    assert.throws(() => parsePromoteAdminArgs([]), /required option.*--email/i)
  })

  test('throws when --email is only whitespace', () => {
    assert.throws(() => parsePromoteAdminArgs(['--email', '   ']), /must not be empty/)
  })

  test('never calls process.exit on a bad argv (commander exitOverride is in effect)', () => {
    // A bare Error, not commander's CommanderError with an exitCode side effect, proves
    // exitOverride() is wired -- the real regression this guards is `process.exit()` firing mid test
    // run and killing the whole suite.
    assert.throws(() => parsePromoteAdminArgs(['--unknown-flag']), Error)
  })
})

describe('promoteUserToAdmin', () => {
  test('returns not-found and writes nothing when no user matches the email', async () => {
    const setUserGroups = mock.fn(async () => {})
    const WIKI = makeWiki({ getByEmail: mock.fn(async () => null), setUserGroups })

    const outcome = await promoteUserToAdmin(WIKI, 'nobody@example.com')

    assert.deepEqual(outcome, { status: 'not-found', email: 'nobody@example.com' })
    assert.equal(setUserGroups.mock.calls.length, 0)
  })

  test('refuses a system account (e.g. guest) and writes nothing', async () => {
    const setUserGroups = mock.fn(async () => {})
    const WIKI = makeWiki({
      getByEmail: mock.fn(async () => ({
        id: 'guest-id',
        name: 'Guest',
        email: 'guest@example.com',
        isSystem: true
      })),
      setUserGroups
    })

    const outcome = await promoteUserToAdmin(WIKI, 'guest@example.com')

    assert.deepEqual(outcome, { status: 'system-account', email: 'guest@example.com' })
    assert.equal(setUserGroups.mock.calls.length, 0)
  })

  test('returns already-admin and writes nothing when already a member', async () => {
    const setUserGroups = mock.fn(async () => {})
    const WIKI = makeWiki({
      getByEmail: mock.fn(async () => ({
        id: 'user-1',
        name: 'Jane',
        email: 'jane@example.com',
        isSystem: false
      })),
      isUserInGroup: mock.fn(async () => true),
      setUserGroups
    })

    const outcome = await promoteUserToAdmin(WIKI, 'jane@example.com')

    assert.deepEqual(outcome, {
      status: 'already-admin',
      userId: 'user-1',
      name: 'Jane',
      email: 'jane@example.com'
    })
    assert.equal(setUserGroups.mock.calls.length, 0)
  })

  test('promotes an existing non-admin user, preserving their existing group memberships', async () => {
    const setUserGroups = mock.fn(async (_userId: string, _groupIds: string[]) => {})
    const WIKI = makeWiki({
      getByEmail: mock.fn(async () => ({
        id: 'user-2',
        name: 'John',
        email: 'john@example.com',
        isSystem: false
      })),
      isUserInGroup: mock.fn(async () => false),
      getUserGroupIds: mock.fn(async () => ['editors-group-id', 'users-group-id']),
      setUserGroups
    })

    const outcome = await promoteUserToAdmin(WIKI, 'john@example.com')

    assert.deepEqual(outcome, {
      status: 'promoted',
      userId: 'user-2',
      name: 'John',
      email: 'john@example.com'
    })
    assert.equal(setUserGroups.mock.calls.length, 1)
    const [userId, groupIds] = setUserGroups.mock.calls[0].arguments
    assert.equal(userId, 'user-2')
    assert.deepEqual(groupIds, ['editors-group-id', 'users-group-id', ADMIN_GROUP_ID])
  })

  test('throws when the Administrators group id cannot be resolved', async () => {
    const WIKI = {
      config: { auth: {} },
      models: {
        users: { getByEmail: mock.fn(async () => null) },
        groups: { isUserInGroup: mock.fn(async () => false) }
      }
    } as unknown as PromoteAdminWiki
    await assert.rejects(
      () => promoteUserToAdmin(WIKI, 'anyone@example.com'),
      /Could not resolve the Administrators group id/
    )
  })
})
