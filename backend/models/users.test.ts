import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { users } from './users.ts'
import { ProvisionableLoginError } from './authentication.ts'

/**
 * `updateSession` is the one place a login turns a user row into session state — permissions
 * flattened across every group the user belongs to, and the group ids kept alongside them since
 * navigation is filtered per group. It touches neither `WIKI` nor the database, so this is a pure
 * unit test: no fixture from `test/db.ts` needed.
 */

function makeUser(overrides: Partial<any> = {}): any {
  return {
    id: 'user-1',
    email: 'ada@example.com',
    name: 'Ada Lovelace',
    hasAvatar: false,
    prefs: {},
    groups: [],
    ...overrides
  }
}

function makeReq(): any {
  return { session: {} }
}

describe('users.updateSession', () => {
  test('marks the session authenticated and copies the core user fields', () => {
    const user = makeUser({
      hasAvatar: true,
      prefs: {
        timezone: 'America/New_York',
        dateFormat: 'YYYY-MM-DD',
        appearance: 'dark',
        cvd: 'none'
      }
    })
    const req = makeReq()

    users.updateSession(user, req)

    assert.equal(req.session.authenticated, true)
    assert.deepEqual(req.session.user, {
      id: 'user-1',
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      hasAvatar: true,
      timezone: 'America/New_York',
      dateFormat: 'YYYY-MM-DD',
      timeFormat: undefined,
      appearance: 'dark',
      cvd: 'none'
    })
  })

  test('flattens permissions across every group the user belongs to', () => {
    const user = makeUser({
      groups: [
        { id: 'group-a', permissions: ['read:pages', 'write:comments'] },
        { id: 'group-b', permissions: ['manage:users'] }
      ]
    })
    const req = makeReq()

    users.updateSession(user, req)

    assert.deepEqual(
      new Set(req.session.permissions),
      new Set(['read:pages', 'write:comments', 'manage:users'])
    )
    assert.equal(req.session.permissions.length, 3)
  })

  test('deduplicates a permission granted by more than one group', () => {
    const user = makeUser({
      groups: [
        { id: 'group-a', permissions: ['read:pages', 'manage:users'] },
        { id: 'group-b', permissions: ['manage:users', 'access:admin'] }
      ]
    })
    const req = makeReq()

    users.updateSession(user, req)

    assert.deepEqual(
      new Set(req.session.permissions),
      new Set(['read:pages', 'manage:users', 'access:admin'])
    )
    assert.equal(req.session.permissions.length, 3)
  })

  test('carries group ids alongside their permissions, in membership order', () => {
    const user = makeUser({
      groups: [
        { id: 'group-a', permissions: ['read:pages'] },
        { id: 'group-b', permissions: [] }
      ]
    })
    const req = makeReq()

    users.updateSession(user, req)

    assert.deepEqual(req.session.groups, ['group-a', 'group-b'])
  })

  test('a user in no groups gets an authenticated session with nothing granted', () => {
    const user = makeUser({ groups: [] })
    const req = makeReq()

    users.updateSession(user, req)

    assert.equal(req.session.authenticated, true)
    assert.deepEqual(req.session.permissions, [])
    assert.deepEqual(req.session.groups, [])
  })
})

/**
 * `syncProviderGroups` reconciles a user's wiki group membership with what an identity provider just
 * reported for them — add/remove by difference, mirroring 2.5.x's `passport-ldapauth` /
 * `passport-saml` modules, but never touching the guests group or a group the strategy's own
 * `autoEnrollGroups` still grants. `WIKI.models.groups` and `users.getUserGroupIds` are stubbed rather
 * than run against a real database: what is under test here is the diffing logic, not group
 * persistence, which `models/groups.test.ts`-style DB-backed suites would be the place to cover.
 */
describe('users.syncProviderGroups', () => {
  const guestsGroupId = 'group-guests'

  before(() => {
    ;(globalThis as any).WIKI = {
      data: { systemIds: { guestsGroupId } },
      models: {
        flags: { authDebug: () => {} }
      }
    }
  })

  after(() => {
    delete (globalThis as any).WIKI
  })

  function makeStrategy(overrides: Partial<any> = {}): any {
    return {
      id: 'strategy-1',
      module: 'ldap',
      autoEnrollGroups: [],
      ...overrides
    }
  }

  function stubGroups(t: any, allGroups: Array<{ id: string; name: string }>) {
    const assignUserToGroup = t.mock.fn(async () => true)
    const unassignUserFromGroup = t.mock.fn(async () => true)
    ;(globalThis as any).WIKI.models.groups = {
      getAllGroups: async () => allGroups,
      assignUserToGroup,
      unassignUserFromGroup
    }
    return { assignUserToGroup, unassignUserFromGroup }
  }

  test('relates a group matching a reported name that the user does not yet have', async (t) => {
    const { assignUserToGroup, unassignUserFromGroup } = stubGroups(t, [
      { id: 'group-editors', name: 'Editors' },
      { id: 'group-other', name: 'Other' }
    ])
    t.mock.method(users, 'getUserGroupIds', async () => [])

    await users.syncProviderGroups({ id: 'user-1' }, makeStrategy(), ['editors'])

    assert.equal(assignUserToGroup.mock.calls.length, 1)
    assert.deepEqual(assignUserToGroup.mock.calls[0].arguments, ['group-editors', 'user-1'])
    assert.equal(unassignUserFromGroup.mock.calls.length, 0)
  })

  test('unrelates a group the user currently has that is no longer reported', async (t) => {
    const { assignUserToGroup, unassignUserFromGroup } = stubGroups(t, [
      { id: 'group-editors', name: 'Editors' },
      { id: 'group-other', name: 'Other' }
    ])
    t.mock.method(users, 'getUserGroupIds', async () => ['group-editors', 'group-other'])

    await users.syncProviderGroups({ id: 'user-1' }, makeStrategy(), ['Editors'])

    assert.equal(assignUserToGroup.mock.calls.length, 0)
    assert.equal(unassignUserFromGroup.mock.calls.length, 1)
    assert.deepEqual(unassignUserFromGroup.mock.calls[0].arguments, ['group-other', 'user-1'])
  })

  test('never adds or removes the guests group, even if reported by name', async (t) => {
    const { assignUserToGroup, unassignUserFromGroup } = stubGroups(t, [
      { id: guestsGroupId, name: 'Guests' }
    ])
    t.mock.method(users, 'getUserGroupIds', async () => [guestsGroupId])

    await users.syncProviderGroups({ id: 'user-1' }, makeStrategy(), ['Guests'])

    assert.equal(assignUserToGroup.mock.calls.length, 0)
    assert.equal(unassignUserFromGroup.mock.calls.length, 0)
  })

  test('does not remove a group still granted by the strategy autoEnrollGroups', async (t) => {
    const { assignUserToGroup, unassignUserFromGroup } = stubGroups(t, [
      { id: 'group-editors', name: 'Editors' }
    ])
    t.mock.method(users, 'getUserGroupIds', async () => ['group-editors'])

    await users.syncProviderGroups(
      { id: 'user-1' },
      makeStrategy({ autoEnrollGroups: ['group-editors'] }),
      []
    )

    assert.equal(assignUserToGroup.mock.calls.length, 0)
    assert.equal(unassignUserFromGroup.mock.calls.length, 0)
  })

  test('adds and removes together when both sides of the diff are non-empty', async (t) => {
    const { assignUserToGroup, unassignUserFromGroup } = stubGroups(t, [
      { id: 'group-editors', name: 'Editors' },
      { id: 'group-reviewers', name: 'Reviewers' }
    ])
    t.mock.method(users, 'getUserGroupIds', async () => ['group-reviewers'])

    await users.syncProviderGroups({ id: 'user-1' }, makeStrategy(), ['Editors'])

    assert.deepEqual(assignUserToGroup.mock.calls[0].arguments, ['group-editors', 'user-1'])
    assert.deepEqual(unassignUserFromGroup.mock.calls[0].arguments, ['group-reviewers', 'user-1'])
  })
})

/**
 * `login()`'s form-based auto-provisioning branch: a module like LDAP verifies the person itself and,
 * rather than resolving a local user, always signals "this person is real" by throwing
 * `ProvisionableLoginError` — whether or not an account already exists for them (see that class's own
 * doc comment, and `modules/authentication/ldap/authentication.ts`, the module this branch was built
 * for). What is under test here is `login()`'s own dispatch around that catch: `findOrCreateProviderUser()`
 * and `afterLoginChecks()` are stubbed so a returning-vs-new-address distinction can be driven directly,
 * without a database.
 *
 * Regression coverage for a real bug this suite caught: `login()` used to refuse *every* form-based
 * provider login with `ERR_REGISTRATION_DISABLED` the moment a strategy's `registration` flag was off —
 * including a returning user who already has an account. `registration` means "accepts new users", not
 * "accepts logins", and `findOrCreateProviderUser()` already enforces it correctly on its own (only for
 * an address with no existing account) — so `login()` no longer re-checks it before calling in.
 */
describe('users.login (form-based provider auto-provisioning)', () => {
  const strategyId = 'strategy-1'

  function makeProfile(overrides: Partial<any> = {}): any {
    return { id: 'ext-1', email: 'ada@example.com', name: 'Ada Lovelace', ...overrides }
  }

  function installWiki(getStrategyById: () => Promise<any>) {
    ;(globalThis as any).WIKI = {
      data: { authentication: [{ key: 'ldap', useForm: true }] },
      auth: {
        strategies: {
          [strategyId]: {
            module: 'ldap',
            authenticate: async () => {
              throw new ProvisionableLoginError(makeProfile())
            }
          }
        }
      },
      models: {
        flags: { authDebug: () => {} },
        authentication: { getStrategyById }
      }
    }
  }

  after(() => {
    delete (globalThis as any).WIKI
  })

  test('a returning provider user is not refused just because the strategy has registration disabled', async (t) => {
    installWiki(async () => ({ id: strategyId, module: 'ldap', registration: false, config: {} }))
    const fakeUser = { id: 'user-1' }
    const findOrCreate = t.mock.method(
      users,
      'findOrCreateProviderUser' as any,
      async () => fakeUser
    )
    const afterLogin = t.mock.method(users, 'afterLoginChecks', async () => ({
      authenticated: true,
      nextAction: 'redirect',
      redirect: '/'
    }))

    const result = await users.login(
      { siteId: 'site-1', strategyId, username: 'ada', password: 'pw', ip: '127.0.0.1' },
      { session: {} }
    )

    assert.equal(result.authenticated, true)
    assert.equal(findOrCreate.mock.calls.length, 1)
    assert.equal(findOrCreate.mock.calls[0].arguments[1].email, 'ada@example.com')
    assert.equal(afterLogin.mock.calls[0].arguments[0], fakeUser)
  })

  test('a brand-new address is still refused when the strategy does not accept new users', async (t) => {
    installWiki(async () => ({ id: strategyId, module: 'ldap', registration: false, config: {} }))
    t.mock.method(users, 'findOrCreateProviderUser' as any, async () => {
      throw new Error('ERR_REGISTRATION_DISABLED')
    })

    await assert.rejects(
      users.login(
        { siteId: 'site-1', strategyId, username: 'ada', password: 'pw', ip: '127.0.0.1' },
        { session: {} }
      ),
      /ERR_REGISTRATION_DISABLED/
    )
  })

  test('registration enabled still provisions a brand-new address', async (t) => {
    installWiki(async () => ({ id: strategyId, module: 'ldap', registration: true, config: {} }))
    const fakeUser = { id: 'user-2' }
    t.mock.method(users, 'findOrCreateProviderUser' as any, async () => fakeUser)
    const afterLogin = t.mock.method(users, 'afterLoginChecks', async () => ({
      authenticated: true,
      nextAction: 'redirect',
      redirect: '/'
    }))

    await users.login(
      { siteId: 'site-1', strategyId, username: 'ada', password: 'pw', ip: '127.0.0.1' },
      { session: {} }
    )

    assert.equal(afterLogin.mock.calls[0].arguments[0], fakeUser)
  })

  test('a strategy record that no longer exists is reported as ERR_INVALID_STRATEGY', async (t) => {
    installWiki(async () => null)
    const findOrCreate = t.mock.method(users, 'findOrCreateProviderUser' as any, async () => ({}))

    await assert.rejects(
      users.login(
        { siteId: 'site-1', strategyId, username: 'ada', password: 'pw', ip: '127.0.0.1' },
        { session: {} }
      ),
      /ERR_INVALID_STRATEGY/
    )
    assert.equal(findOrCreate.mock.calls.length, 0)
  })
})
