import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, LOGIN_REFUSAL_REASONS } from './login.ts'
import { userCredentials } from './userCredentials.ts'
import { createWikiStub, installTestWiki } from '../test/mocks.ts'
import { users } from './users.ts'
import { ProvisionableLoginError } from './authentication.ts'
import { AccountRateLimitedError } from '../helpers/rateLimit.ts'
import { resetCoalesce } from '../helpers/logCoalesce.ts'

/**
 * `syncProviderGroups` reconciles a user's wiki group membership with what an identity provider just
 * reported for them — add/remove by difference, mirroring 2.5.x's `passport-ldapauth` /
 * `passport-saml` modules, but never touching the guests group, a group the strategy's own
 * `autoEnrollGroups` still grants, a group carrying `manage:system`, or the configured root
 * administrators group — and never granting or revoking a group outside the strategy's own
 * `mappableGroups` allow-list. `WIKI.models.groups` and `users.getUserGroupIds` are stubbed rather
 * than run against a real database: what is under test here is the diffing logic, not group
 * persistence, which `models/groups.test.ts`-style DB-backed suites would be the place to cover.
 */
describe('login.syncProviderGroups', () => {
  const guestsGroupId = 'group-guests'
  const rootAdminGroupId = 'group-root-admin'

  let wiki: { restore(): void }

  before(() => {
    wiki = installTestWiki({
      data: { systemIds: { guestsGroupId } },
      config: { auth: { rootAdminGroupId } },
      models: {
        flags: { authDebug: () => {} },
        // -> The real singleton, not a stub: `syncProviderGroups` reads the membership it is
        //    diffing against through `WIKI.models.users.getUserGroupIds`, which each test below
        //    mocks on that same object.
        users
      }
    })
  })

  after(() => wiki.restore())

  // `mappableGroups` defaults to empty, same as the real column default — a test exercising a grant
  // or removal has to opt a group into the allow-list explicitly, same as an administrator would.
  function makeStrategy(overrides: Partial<any> = {}): any {
    return {
      id: 'strategy-1',
      module: 'ldap',
      autoEnrollGroups: [],
      mappableGroups: [],
      ...overrides
    }
  }

  /**
   * @param allGroups A group may carry `permissions: ['manage:system']`, which is what
   *   `groups.systemGroupIds()` is stubbed to key off of — mirroring the real implementation.
   */
  function stubGroups(
    t: any,
    allGroups: Array<{ id: string; name: string; permissions?: string[] }>
  ) {
    const assignUserToGroup = t.mock.fn(async () => true)
    const unassignUserFromGroup = t.mock.fn(async () => true)
    ;(WIKI.models as any).groups = {
      getAllGroups: async () => allGroups,
      systemGroupIds: async () =>
        allGroups.filter((g) => g.permissions?.includes('manage:system')).map((g) => g.id),
      assignUserToGroup,
      unassignUserFromGroup
    }
    return { assignUserToGroup, unassignUserFromGroup }
  }

  test('relates an allow-listed group matching a reported name that the user does not yet have', async (t) => {
    const { assignUserToGroup, unassignUserFromGroup } = stubGroups(t, [
      { id: 'group-editors', name: 'Editors' },
      { id: 'group-other', name: 'Other' }
    ])
    t.mock.method(users, 'getUserGroupIds', async () => [])

    await login.syncProviderGroups(
      { id: 'user-1' },
      makeStrategy({ mappableGroups: ['group-editors', 'group-other'] }),
      ['editors']
    )

    assert.equal(assignUserToGroup.mock.calls.length, 1)
    assert.deepEqual(assignUserToGroup.mock.calls[0].arguments, ['group-editors', 'user-1'])
    assert.equal(unassignUserFromGroup.mock.calls.length, 0)
  })

  test('unrelates an allow-listed group the user currently has that is no longer reported', async (t) => {
    const { assignUserToGroup, unassignUserFromGroup } = stubGroups(t, [
      { id: 'group-editors', name: 'Editors' },
      { id: 'group-other', name: 'Other' }
    ])
    t.mock.method(users, 'getUserGroupIds', async () => ['group-editors', 'group-other'])

    await login.syncProviderGroups(
      { id: 'user-1' },
      makeStrategy({ mappableGroups: ['group-editors', 'group-other'] }),
      ['Editors']
    )

    assert.equal(assignUserToGroup.mock.calls.length, 0)
    assert.equal(unassignUserFromGroup.mock.calls.length, 1)
    assert.deepEqual(unassignUserFromGroup.mock.calls[0].arguments, ['group-other', 'user-1'])
  })

  test('never adds or removes the guests group, even if reported by name and allow-listed', async (t) => {
    const { assignUserToGroup, unassignUserFromGroup } = stubGroups(t, [
      { id: guestsGroupId, name: 'Guests' }
    ])
    t.mock.method(users, 'getUserGroupIds', async () => [guestsGroupId])

    await login.syncProviderGroups(
      { id: 'user-1' },
      makeStrategy({ mappableGroups: [guestsGroupId] }),
      ['Guests']
    )

    assert.equal(assignUserToGroup.mock.calls.length, 0)
    assert.equal(unassignUserFromGroup.mock.calls.length, 0)
  })

  test('does not remove a group still granted by the strategy autoEnrollGroups', async (t) => {
    const { assignUserToGroup, unassignUserFromGroup } = stubGroups(t, [
      { id: 'group-editors', name: 'Editors' }
    ])
    t.mock.method(users, 'getUserGroupIds', async () => ['group-editors'])

    await login.syncProviderGroups(
      { id: 'user-1' },
      makeStrategy({ autoEnrollGroups: ['group-editors'], mappableGroups: ['group-editors'] }),
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

    await login.syncProviderGroups(
      { id: 'user-1' },
      makeStrategy({ mappableGroups: ['group-editors', 'group-reviewers'] }),
      ['Editors']
    )

    assert.deepEqual(assignUserToGroup.mock.calls[0].arguments, ['group-editors', 'user-1'])
    assert.deepEqual(unassignUserFromGroup.mock.calls[0].arguments, ['group-reviewers', 'user-1'])
  })

  test('a reported name matching a manage:system group grants nothing, even if allow-listed', async (t) => {
    const { assignUserToGroup, unassignUserFromGroup } = stubGroups(t, [
      { id: 'group-admins', name: 'Administrators', permissions: ['manage:system'] }
    ])
    t.mock.method(users, 'getUserGroupIds', async () => [])

    await login.syncProviderGroups(
      { id: 'user-1' },
      makeStrategy({ mappableGroups: ['group-admins'] }),
      ['administrators']
    )

    assert.equal(assignUserToGroup.mock.calls.length, 0)
    assert.equal(unassignUserFromGroup.mock.calls.length, 0)
  })

  test('the root administrators group is never granted, even if allow-listed and reported', async (t) => {
    const { assignUserToGroup, unassignUserFromGroup } = stubGroups(t, [
      { id: rootAdminGroupId, name: 'Root Admins' }
    ])
    t.mock.method(users, 'getUserGroupIds', async () => [])

    await login.syncProviderGroups(
      { id: 'user-1' },
      makeStrategy({ mappableGroups: [rootAdminGroupId] }),
      ['root admins']
    )

    assert.equal(assignUserToGroup.mock.calls.length, 0)
    assert.equal(unassignUserFromGroup.mock.calls.length, 0)
  })

  test('an existing Administrators membership survives a login whose IdP reports no groups', async (t) => {
    const { assignUserToGroup, unassignUserFromGroup } = stubGroups(t, [
      { id: 'group-admins', name: 'Administrators', permissions: ['manage:system'] }
    ])
    t.mock.method(users, 'getUserGroupIds', async () => ['group-admins'])

    await login.syncProviderGroups(
      { id: 'user-1' },
      makeStrategy({ mappableGroups: ['group-admins'] }),
      []
    )

    assert.equal(assignUserToGroup.mock.calls.length, 0)
    assert.equal(unassignUserFromGroup.mock.calls.length, 0)
  })

  test('a group outside the allow-list is neither granted nor removed', async (t) => {
    const { assignUserToGroup, unassignUserFromGroup } = stubGroups(t, [
      { id: 'group-editors', name: 'Editors' },
      { id: 'group-reviewers', name: 'Reviewers' }
    ])
    // -> The user already holds group-reviewers, and the IdP reports Editors: with a full
    //    allow-list both halves of the diff would fire, but neither group is listed here.
    t.mock.method(users, 'getUserGroupIds', async () => ['group-reviewers'])

    await login.syncProviderGroups({ id: 'user-1' }, makeStrategy({ mappableGroups: [] }), [
      'Editors'
    ])

    assert.equal(assignUserToGroup.mock.calls.length, 0)
    assert.equal(unassignUserFromGroup.mock.calls.length, 0)
  })

  test('the default empty allow-list makes a provider login a no-op for memberships', async (t) => {
    const { assignUserToGroup, unassignUserFromGroup } = stubGroups(t, [
      { id: 'group-editors', name: 'Editors' },
      { id: 'group-reviewers', name: 'Reviewers' }
    ])
    t.mock.method(users, 'getUserGroupIds', async () => ['group-reviewers'])

    // -> makeStrategy() defaults mappableGroups to [], matching an unconfigured real strategy.
    await login.syncProviderGroups({ id: 'user-1' }, makeStrategy(), ['Editors', 'Reviewers'])

    assert.equal(assignUserToGroup.mock.calls.length, 0)
    assert.equal(unassignUserFromGroup.mock.calls.length, 0)
  })
})

/**
 * `loginTFA`'s new job is dispatch: decide whether a submitted code is shaped like a TOTP code or a
 * recovery code, refuse a recovery code mid-setup (none exist yet for a secret nobody has activated),
 * and refuse one outright once every stored code is spent. Every collaborator this touches —
 * `validateToken`, `verifyTfaCode`, `verifyAndConsumeRecoveryCode`, `destroyToken`, `enableTfa`,
 * `afterLoginChecks` — is a `WIKI`/database-backed method of the same `users` singleton, so the
 * dispatch logic itself is tested by mocking those methods on the instance (restored automatically
 * after each test) rather than standing up a database for behavior that is not SQL.
 */
describe('login.loginTFA', () => {
  function makeUser(overrides: Partial<any> = {}): any {
    return { id: 'user-1', email: 'ada@example.com', auth: { strat: {} }, ...overrides }
  }

  // -> `loginTFA` now consumes the account-keyed rate limit (work package 2075(b)) before verifying
  //    the submitted code — a real `WIKI.models.rateLimits.consume` stand-in that always allows,
  //    exactly like `syncProviderGroups`'s own `before`/`after` above, since nothing in this suite is
  //    testing the limiter itself (see `helpers/rateLimit.test.ts#consumeAccountAuthAttempt` for that).
  let wiki: { restore(): void }

  before(() => {
    wiki = installTestWiki({
      config: { security: {} },
      models: {
        flags: { authDebug: () => {} },
        rateLimits: { consume: async () => ({ allowed: true, hits: 1, retryAfter: 0 }) },
        // -> The real singleton, so the `userCredentials.*` mocks each test installs are the ones
        //    `loginTFA` actually reaches through `WIKI.models.userCredentials`.
        userCredentials
      }
    })
  })

  after(() => wiki.restore())

  test('rejects a code shaped like neither a TOTP code nor a recovery code, before validating the token', async (t) => {
    const validateToken = t.mock.method(userCredentials, 'validateToken', async () => {
      throw new Error('should not be called')
    })

    await assert.rejects(
      login.loginTFA(
        { strategyId: 'strat', siteId: 'site-1', securityCode: 'nope', continuationToken: 'tok' },
        {}
      ),
      /ERR_TFA_INVALID_REQUEST/
    )
    assert.equal(validateToken.mock.callCount(), 0)
  })

  test('rejects a recovery code submitted to complete a setup login', async (t) => {
    const validateToken = t.mock.method(userCredentials, 'validateToken', async () => {
      throw new Error('should not be called')
    })

    await assert.rejects(
      login.loginTFA(
        {
          strategyId: 'strat',
          siteId: 'site-1',
          securityCode: 'AAAA-BBBB-CCCC-DDDD',
          continuationToken: 'tok',
          setup: true
        },
        {}
      ),
      /ERR_TFA_INVALID_REQUEST/
    )
    assert.equal(validateToken.mock.callCount(), 0)
  })

  test('rejects a well-shaped code with no continuation token', async () => {
    await assert.rejects(
      login.loginTFA(
        { strategyId: 'strat', siteId: 'site-1', securityCode: '123456', continuationToken: '' },
        {}
      ),
      /ERR_TFA_INVALID_REQUEST/
    )
  })

  test('a 6-digit code is routed to verifyTfaCode, not verifyAndConsumeRecoveryCode', async (t) => {
    const user = makeUser()
    t.mock.method(userCredentials, 'validateToken', async () => ({ user, strategyId: 'strat' }))
    const verifyTfaCode = t.mock.method(userCredentials, 'verifyTfaCode', () => true)
    const verifyRecovery = t.mock.method(
      userCredentials,
      'verifyAndConsumeRecoveryCode',
      async () => false
    )
    t.mock.method(userCredentials, 'destroyToken', async () => {})
    t.mock.method(login, 'afterLoginChecks', async () => ({
      nextAction: 'redirect',
      redirect: '/'
    }))

    const result = await login.loginTFA(
      { strategyId: 'strat', siteId: 'site-1', securityCode: '123456', continuationToken: 'tok' },
      {}
    )

    assert.equal(verifyTfaCode.mock.callCount(), 1)
    assert.equal(verifyRecovery.mock.callCount(), 0)
    assert.equal(result.nextAction, 'redirect')
  })

  // -> OpenProject #2361: same typed-error requirement as `login.login`'s own rate-limit test above --
  //    a refused account-keyed attempt on the 2FA step must throw `AccountRateLimitedError` (carrying
  //    `retryAfter`), not a plain `Error('ERR_RATE_LIMITED')`, so the route handler can answer 429
  //    instead of the generic `ERR_`-prefix 400. Refused after `validateToken` resolves the user (the
  //    rate limit is keyed on `user.email`) but before the submitted code is ever verified.
  test("a refused account-keyed rate limit throws AccountRateLimitedError with the verdict's retryAfter, before the code is verified", async (t) => {
    const user = makeUser()
    t.mock.method(userCredentials, 'validateToken', async () => ({ user, strategyId: 'strat' }))
    t.mock.method(WIKI.models.rateLimits, 'consume', async () => ({
      allowed: false,
      hits: 999,
      retryAfter: 17
    }))
    const verifyTfaCode = t.mock.method(userCredentials, 'verifyTfaCode', () => true)

    await assert.rejects(
      login.loginTFA(
        { strategyId: 'strat', siteId: 'site-1', securityCode: '123456', continuationToken: 'tok' },
        {}
      ),
      (err: any) => {
        assert.ok(err instanceof AccountRateLimitedError)
        assert.equal(err.retryAfter, 17)
        assert.equal(err.message, 'ERR_RATE_LIMITED')
        return true
      }
    )
    assert.equal(verifyTfaCode.mock.callCount(), 0)
  })

  test('a dash-shaped code is routed to verifyAndConsumeRecoveryCode, not verifyTfaCode', async (t) => {
    const user = makeUser({
      auth: { strat: { recoveryCodes: [{ hash: 'x', usedAt: null }] } }
    })
    t.mock.method(userCredentials, 'validateToken', async () => ({ user, strategyId: 'strat' }))
    const verifyTfaCode = t.mock.method(userCredentials, 'verifyTfaCode', () => false)
    const verifyRecovery = t.mock.method(
      userCredentials,
      'verifyAndConsumeRecoveryCode',
      async () => true
    )
    t.mock.method(userCredentials, 'destroyToken', async () => {})
    t.mock.method(login, 'afterLoginChecks', async () => ({
      nextAction: 'redirect',
      redirect: '/'
    }))

    await login.loginTFA(
      {
        strategyId: 'strat',
        siteId: 'site-1',
        securityCode: 'AAAA-BBBB-CCCC-DDDD',
        continuationToken: 'tok'
      },
      {}
    )

    assert.equal(verifyTfaCode.mock.callCount(), 0)
    assert.equal(verifyRecovery.mock.callCount(), 1)
  })

  test('rejects a recovery code once every stored code is consumed, without calling verifyAndConsumeRecoveryCode', async (t) => {
    const user = makeUser({
      auth: {
        strat: { recoveryCodes: [{ hash: 'x', usedAt: '2024-01-01T00:00:00.000Z' }] }
      }
    })
    t.mock.method(userCredentials, 'validateToken', async () => ({ user, strategyId: 'strat' }))
    const verifyRecovery = t.mock.method(
      userCredentials,
      'verifyAndConsumeRecoveryCode',
      async () => true
    )

    await assert.rejects(
      login.loginTFA(
        {
          strategyId: 'strat',
          siteId: 'site-1',
          securityCode: 'AAAA-BBBB-CCCC-DDDD',
          continuationToken: 'tok'
        },
        {}
      ),
      /ERR_TFA_RECOVERY_CODES_EXHAUSTED/
    )
    assert.equal(verifyRecovery.mock.callCount(), 0)
  })

  test('a recovery code is accepted when at least one stored code is still unconsumed', async (t) => {
    const user = makeUser({
      auth: {
        strat: {
          recoveryCodes: [
            { hash: 'x', usedAt: '2024-01-01T00:00:00.000Z' },
            { hash: 'y', usedAt: null }
          ]
        }
      }
    })
    t.mock.method(userCredentials, 'validateToken', async () => ({ user, strategyId: 'strat' }))
    const verifyRecovery = t.mock.method(
      userCredentials,
      'verifyAndConsumeRecoveryCode',
      async () => true
    )
    t.mock.method(userCredentials, 'destroyToken', async () => {})
    t.mock.method(login, 'afterLoginChecks', async () => ({
      nextAction: 'redirect',
      redirect: '/'
    }))

    const result = await login.loginTFA(
      {
        strategyId: 'strat',
        siteId: 'site-1',
        securityCode: 'AAAA-BBBB-CCCC-DDDD',
        continuationToken: 'tok'
      },
      {}
    )

    assert.equal(verifyRecovery.mock.callCount(), 1)
    assert.equal(result.nextAction, 'redirect')
  })

  test('a successful setup login surfaces the recovery codes enableTfa just issued', async (t) => {
    const user = makeUser()
    t.mock.method(userCredentials, 'validateToken', async () => ({ user, strategyId: 'strat' }))
    t.mock.method(userCredentials, 'verifyTfaCode', () => true)
    t.mock.method(userCredentials, 'destroyToken', async () => {})
    t.mock.method(userCredentials, 'enableTfa', async () => ['CODE-1111', 'CODE-2222'])
    t.mock.method(login, 'afterLoginChecks', async () => ({
      nextAction: 'redirect',
      redirect: '/'
    }))

    const result = await login.loginTFA(
      {
        strategyId: 'strat',
        siteId: 'site-1',
        securityCode: '123456',
        continuationToken: 'tok',
        setup: true
      },
      {}
    )

    assert.deepEqual(result.recoveryCodes, ['CODE-1111', 'CODE-2222'])
  })

  test('a plain (non-setup) login never carries recoveryCodes in the result', async (t) => {
    const user = makeUser()
    t.mock.method(userCredentials, 'validateToken', async () => ({ user, strategyId: 'strat' }))
    t.mock.method(userCredentials, 'verifyTfaCode', () => true)
    t.mock.method(userCredentials, 'destroyToken', async () => {})
    t.mock.method(login, 'afterLoginChecks', async () => ({
      nextAction: 'redirect',
      redirect: '/'
    }))

    const result = await login.loginTFA(
      { strategyId: 'strat', siteId: 'site-1', securityCode: '123456', continuationToken: 'tok' },
      {}
    )

    assert.equal('recoveryCodes' in result, false)
  })

  test('verifies against tfaStrategyId from the token, not the login strategyId, when the token carries one', async (t) => {
    const user = makeUser({ auth: { strat: {}, local: {} } })
    t.mock.method(userCredentials, 'validateToken', async () => ({
      user,
      strategyId: 'strat',
      tfaStrategyId: 'local'
    }))
    const verifyTfaCode = t.mock.method(userCredentials, 'verifyTfaCode', () => true)
    t.mock.method(userCredentials, 'destroyToken', async () => {})
    t.mock.method(login, 'afterLoginChecks', async () => ({
      nextAction: 'redirect',
      redirect: '/'
    }))

    await login.loginTFA(
      { strategyId: 'strat', siteId: 'site-1', securityCode: '123456', continuationToken: 'tok' },
      {}
    )

    assert.deepEqual(verifyTfaCode.mock.calls[0].arguments, [user, 'local', '123456'])
  })

  test('falls back to the login strategyId when the token carries no tfaStrategyId', async (t) => {
    const user = makeUser()
    t.mock.method(userCredentials, 'validateToken', async () => ({ user, strategyId: 'strat' }))
    const verifyTfaCode = t.mock.method(userCredentials, 'verifyTfaCode', () => true)
    t.mock.method(userCredentials, 'destroyToken', async () => {})
    t.mock.method(login, 'afterLoginChecks', async () => ({
      nextAction: 'redirect',
      redirect: '/'
    }))

    await login.loginTFA(
      { strategyId: 'strat', siteId: 'site-1', securityCode: '123456', continuationToken: 'tok' },
      {}
    )

    assert.deepEqual(verifyTfaCode.mock.calls[0].arguments, [user, 'strat', '123456'])
  })

  test('rejects a submission whose strategyId does not match the one the token was issued for', async (t) => {
    const user = makeUser()
    t.mock.method(userCredentials, 'validateToken', async () => ({
      user,
      strategyId: 'a-different-strategy'
    }))

    await assert.rejects(
      login.loginTFA(
        { strategyId: 'strat', siteId: 'site-1', securityCode: '123456', continuationToken: 'tok' },
        {}
      ),
      /ERR_INVALID_STRATEGY/
    )
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
 * provider login with `ERR_REGISTRATION_DISABLED` the moment a strategy's `autoProvision` flag was off —
 * including a returning user who already has an account. `autoProvision` means "accepts new users", not
 * "accepts logins", and `findOrCreateProviderUser()` already enforces it correctly on its own (only for
 * an address with no existing account) — so `login()` no longer re-checks it before calling in.
 */
describe('login.login (form-based provider auto-provisioning)', () => {
  const strategyId = 'strategy-1'

  function makeProfile(overrides: Partial<any> = {}): any {
    return { id: 'ext-1', email: 'ada@example.com', name: 'Ada Lovelace', ...overrides }
  }

  function installWiki(getStrategyById: () => Promise<any>) {
    globalThis.WIKI = createWikiStub({
      config: { security: {} },
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
        authentication: { getStrategyById },
        // -> `login()` now consumes the account-keyed rate limit (work package 2075(b)) before
        //    calling `str.authenticate()` -- a real stand-in that always allows, since nothing in
        //    this suite is testing the limiter itself.
        rateLimits: { consume: async () => ({ allowed: true, hits: 1, retryAfter: 0 }) }
      }
    })
  }

  let wiki: { restore(): void }

  before(() => {
    wiki = installTestWiki()
  })

  after(() => wiki.restore())

  test('a returning provider user is not refused just because the strategy has autoProvision disabled', async (t) => {
    installWiki(async () => ({ id: strategyId, module: 'ldap', autoProvision: false, config: {} }))
    const fakeUser = { id: 'user-1' }
    const findOrCreate = t.mock.method(
      login,
      'findOrCreateProviderUser' as any,
      async () => fakeUser
    )
    const afterLogin = t.mock.method(login, 'afterLoginChecks', async () => ({
      authenticated: true,
      nextAction: 'redirect',
      redirect: '/'
    }))

    const result = await login.login(
      { siteId: 'site-1', strategyId, username: 'ada', password: 'pw', ip: '127.0.0.1' },
      { session: {} }
    )

    assert.equal(result.authenticated, true)
    assert.equal(findOrCreate.mock.calls.length, 1)
    assert.equal(findOrCreate.mock.calls[0].arguments[1].email, 'ada@example.com')
    assert.equal(afterLogin.mock.calls[0].arguments[0], fakeUser)
  })

  test('a brand-new address is still refused when the strategy does not accept new users', async (t) => {
    installWiki(async () => ({ id: strategyId, module: 'ldap', autoProvision: false, config: {} }))
    t.mock.method(login, 'findOrCreateProviderUser' as any, async () => {
      throw new Error('ERR_REGISTRATION_DISABLED')
    })

    await assert.rejects(
      login.login(
        { siteId: 'site-1', strategyId, username: 'ada', password: 'pw', ip: '127.0.0.1' },
        { session: {} }
      ),
      /ERR_REGISTRATION_DISABLED/
    )
  })

  test('autoProvision enabled still provisions a brand-new address', async (t) => {
    installWiki(async () => ({ id: strategyId, module: 'ldap', autoProvision: true, config: {} }))
    const fakeUser = { id: 'user-2' }
    t.mock.method(login, 'findOrCreateProviderUser' as any, async () => fakeUser)
    const afterLogin = t.mock.method(login, 'afterLoginChecks', async () => ({
      authenticated: true,
      nextAction: 'redirect',
      redirect: '/'
    }))

    await login.login(
      { siteId: 'site-1', strategyId, username: 'ada', password: 'pw', ip: '127.0.0.1' },
      { session: {} }
    )

    assert.equal(afterLogin.mock.calls[0].arguments[0], fakeUser)
  })

  test('a strategy record that no longer exists is reported as ERR_INVALID_STRATEGY', async (t) => {
    installWiki(async () => null)
    const findOrCreate = t.mock.method(login, 'findOrCreateProviderUser' as any, async () => ({}))

    await assert.rejects(
      login.login(
        { siteId: 'site-1', strategyId, username: 'ada', password: 'pw', ip: '127.0.0.1' },
        { session: {} }
      ),
      /ERR_INVALID_STRATEGY/
    )
    assert.equal(findOrCreate.mock.calls.length, 0)
  })

  // -> OpenProject #2361: a refused account-keyed attempt must throw the typed
  //    `AccountRateLimitedError` (carrying `retryAfter`), not a plain `Error('ERR_RATE_LIMITED')` --
  //    the route handler (`api/auth/site.ts`) tells the two apart to answer 429 instead of the
  //    generic `ERR_`-prefix 400. Refused before `str.authenticate()` is ever reached, same as the
  //    always-allowed stub in every other test in this block.
  test("a refused account-keyed rate limit throws AccountRateLimitedError with the verdict's retryAfter, before authenticate() runs", async (t) => {
    installWiki(async () => ({ id: strategyId, module: 'ldap', autoProvision: true, config: {} }))
    ;(WIKI.models as any).rateLimits.consume = async () => ({
      allowed: false,
      hits: 999,
      retryAfter: 42
    })
    const findOrCreate = t.mock.method(login, 'findOrCreateProviderUser' as any, async () => {
      throw new Error('should not be called')
    })

    await assert.rejects(
      login.login(
        { siteId: 'site-1', strategyId, username: 'ada', password: 'pw', ip: '127.0.0.1' },
        { session: {} }
      ),
      (err: any) => {
        assert.ok(err instanceof AccountRateLimitedError)
        assert.equal(err.retryAfter, 42)
        assert.equal(err.message, 'ERR_RATE_LIMITED')
        return true
      }
    )
    assert.equal(findOrCreate.mock.calls.length, 0)
  })
})

/**
 * `login()`'s own defense-in-depth guard against an empty/missing password on a `useForm` strategy
 * (LDAP being the one this actually protects, since its module-level check is the other half of the
 * same fix) — the route schema requiring `password` is the first guard, this is the second, and
 * neither is allowed to depend on the other alone.
 */
describe('login.login (empty/missing password guard)', () => {
  const strategyId = 'strategy-1'

  function installWiki(authenticate: () => Promise<any>) {
    globalThis.WIKI = createWikiStub({
      data: { authentication: [{ key: 'ldap', useForm: true }] },
      auth: {
        strategies: {
          [strategyId]: {
            module: 'ldap',
            authenticate
          }
        }
      },
      models: {
        flags: { authDebug: () => {} },
        authentication: { getStrategyById: async () => null }
      }
    })
  }

  let wiki: { restore(): void }

  before(() => {
    wiki = installTestWiki()
  })

  after(() => wiki.restore())

  test('an empty-string password is refused as ERR_LOGIN_FAILED without ever calling the strategy', async (t) => {
    const authenticate = t.mock.fn(async () => {
      throw new Error('should not be called')
    })
    installWiki(authenticate)

    await assert.rejects(
      login.login(
        { siteId: 'site-1', strategyId, username: 'ada', password: '', ip: '127.0.0.1' },
        { session: {} }
      ),
      /ERR_LOGIN_FAILED/
    )
    assert.equal(authenticate.mock.calls.length, 0)
  })

  test('an omitted (undefined) password is refused as ERR_LOGIN_FAILED without ever calling the strategy', async (t) => {
    const authenticate = t.mock.fn(async () => {
      throw new Error('should not be called')
    })
    installWiki(authenticate)

    await assert.rejects(
      login.login(
        { siteId: 'site-1', strategyId, username: 'ada', ip: '127.0.0.1' },
        { session: {} }
      ),
      /ERR_LOGIN_FAILED/
    )
    assert.equal(authenticate.mock.calls.length, 0)
  })
})

/**
 * What the server log says about a login (OpenProject #2673).
 *
 * The audit table's `login.success` / `login.failed` rows are unchanged and are not what this
 * covers — these are the operator-facing lines beside them: one `info auth login` when a session is
 * actually created, and one `warn auth login refused` per refusal, each carrying a `reason` drawn
 * from the closed {@link LOGIN_REFUSAL_REASONS} vocabulary rather than free text.
 *
 * Pure: no database and no real logger. Every case drives a real refusal branch and reads the
 * arguments the logger stub was called with, so a branch rewired to a different reason (or to no
 * line at all) fails here rather than passing quietly.
 */
describe('login outcome logging', () => {
  const strategyId = 'strategy-1'
  const ip = '203.0.113.11'
  const siteId = 'site-1'

  let warn: ReturnType<typeof mock.fn>
  let info: ReturnType<typeof mock.fn>
  let wiki: { restore(): void } | undefined

  /** Every `warn('auth', message, fields)` call, as `[message, fields]`. */
  const warnCalls = (): Array<[string, any]> =>
    warn.mock.calls.map((call: any) => [call.arguments[1], call.arguments[2]])

  /** The single refusal line one case produced, asserted to be exactly one. */
  function soleRefusal(): { message: string; fields: any } {
    const calls = warnCalls().filter(([message]) => message === 'login refused')
    assert.equal(calls.length, 1, `expected one refusal line, got ${JSON.stringify(warnCalls())}`)
    return { message: calls[0][0], fields: calls[0][1] }
  }

  function installWiki(overrides: Record<string, any> = {}): void {
    wiki?.restore()
    warn = mock.fn()
    info = mock.fn()
    wiki = installTestWiki({
      logger: { warn, info, debug: mock.fn() },
      config: {
        security: {
          authRateLimitEnabled: true,
          authRateLimitMax: 10,
          authRateLimitWindow: '5m',
          authRateLimitBan: '15m'
        }
      },
      data: { authentication: [{ key: 'local', useForm: true }] },
      auth: { strategies: {} },
      models: {
        flags: { authDebug: () => {} },
        rateLimits: { consume: async () => ({ allowed: true, hits: 1, retryAfter: 0 }) },
        auditLog: { record: async () => {} }
      },
      ...overrides
    })
  }

  /** A form-based strategy whose `authenticate()` does whatever the case needs. */
  function withStrategy(authenticate: () => Promise<any>): void {
    installWiki({
      auth: { strategies: { [strategyId]: { module: 'local', authenticate } } }
    })
  }

  beforeEach(() => {
    // -> `logLoginRefused` coalesces per address across calls, and the pending windows are module
    //    level — a burst left over from one case would silence the next case's first refusal.
    resetCoalesce()
    installWiki()
  })

  afterEach(() => {
    resetCoalesce()
    wiki?.restore()
    wiki = undefined
  })

  test('every reason a branch produces is a member of the closed vocabulary', () => {
    assert.equal(
      new Set(LOGIN_REFUSAL_REASONS).size,
      LOGIN_REFUSAL_REASONS.length,
      'no duplicate reasons'
    )
    for (const reason of LOGIN_REFUSAL_REASONS) {
      assert.match(reason, /^[a-z]+(-[a-z]+)*$/, `${reason} should be lowercase and hyphenated`)
    }
  })

  test('refuses a form login with no password as reason=no-password', async () => {
    withStrategy(async () => {
      throw new Error('should not be called')
    })

    await assert.rejects(
      login.login({ siteId, strategyId, username: 'ada', password: '', ip }, { session: {} })
    )

    const { fields } = soleRefusal()
    assert.equal(fields.reason, 'no-password')
    assert.deepEqual(fields, { reason: 'no-password', strategy: strategyId, site: siteId, ip })
  })

  test('refuses a rejected credential as reason=bad-credentials, naming neither user nor password', async () => {
    withStrategy(async () => {
      throw new Error('Invalid password')
    })

    await assert.rejects(
      login.login({ siteId, strategyId, username: 'ada', password: 'hunter2', ip }, { session: {} })
    )

    const { fields } = soleRefusal()
    assert.equal(fields.reason, 'bad-credentials')
    // -> The submitted identifier and the password are the audit row's business, under access
    //    control the server log has none of.
    const rendered = JSON.stringify(fields)
    assert.ok(!rendered.includes('ada'), 'no submitted username in the line')
    assert.ok(!rendered.includes('hunter2'), 'no password in the line')
    assert.ok(!rendered.includes('@'), 'no e-mail address in the line')
  })

  test('refuses an unknown strategy as reason=unknown-strategy', async () => {
    await assert.rejects(
      login.login(
        { siteId, strategyId: 'nope', username: 'ada', password: 'pw', ip },
        { session: {} }
      )
    )

    const { fields } = soleRefusal()
    assert.equal(fields.reason, 'unknown-strategy')
    assert.equal(fields.strategy, 'nope')
  })

  test('refuses an account-rate-limited attempt as reason=account-rate-limited', async () => {
    withStrategy(async () => {
      throw new Error('should not be called')
    })
    ;(WIKI as any).models.rateLimits.consume = async () => ({
      allowed: false,
      hits: 11,
      retryAfter: 900
    })

    await assert.rejects(
      login.login({ siteId, strategyId, username: 'ada', password: 'pw', ip }, { session: {} }),
      /ERR_RATE_LIMITED/
    )

    assert.equal(soleRefusal().fields.reason, 'account-rate-limited')
  })

  test('refuses a deactivated account as reason=inactive-user, naming the account by id', async () => {
    installWiki({ auth: { strategies: { [strategyId]: { module: 'local' } } } })

    await assert.rejects(
      login.afterLoginChecks(
        { id: 'user-7', email: 'ada@example.com', isActive: false, isVerified: true, auth: {} },
        strategyId,
        { ip, siteId }
      ),
      /ERR_INACTIVE_USER/
    )

    const { fields } = soleRefusal()
    assert.deepEqual(fields, {
      reason: 'inactive-user',
      strategy: strategyId,
      site: siteId,
      ip,
      user: 'user-7'
    })
    assert.ok(!JSON.stringify(fields).includes('@'), 'the id, never the address')
  })

  test('refuses an unverified account as reason=user-not-verified', async () => {
    installWiki({ auth: { strategies: { [strategyId]: { module: 'local' } } } })

    await assert.rejects(
      login.afterLoginChecks(
        { id: 'user-7', email: 'ada@example.com', isActive: true, isVerified: false, auth: {} },
        strategyId,
        { ip, siteId }
      ),
      /ERR_USER_NOT_VERIFIED/
    )

    assert.equal(soleRefusal().fields.reason, 'user-not-verified')
  })

  test('refuses a login through a strategy that is no longer loaded as reason=unknown-strategy', async () => {
    await assert.rejects(
      login.afterLoginChecks({ id: 'user-7', auth: {} }, 'gone', { ip, siteId }),
      /ERR_INVALID_STRATEGY/
    )

    assert.equal(soleRefusal().fields.reason, 'unknown-strategy')
  })

  test('refuses a wrong 2FA code as reason=tfa-incorrect-code', async (t) => {
    installWiki({
      auth: { strategies: { strat: { module: 'local' } } },
      models: {
        flags: { authDebug: () => {} },
        rateLimits: { consume: async () => ({ allowed: true, hits: 1, retryAfter: 0 }) },
        userCredentials
      },
      // -> `countTfaFailure` is a module function rather than a method on `userCredentials`, so it
      //    cannot be mocked out; it is let run against a `select()` chain answering no rows, which
      //    is its own early return.
      db: {
        select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) })
      }
    })
    const user = { id: 'user-7', email: 'ada@example.com', auth: { strat: {} } }
    t.mock.method(userCredentials, 'validateToken', async () => ({ user, strategyId: 'strat' }))
    t.mock.method(userCredentials, 'verifyTfaCode', async () => false)

    await assert.rejects(
      login.loginTFA(
        { strategyId: 'strat', siteId, securityCode: '123456', continuationToken: 'tok', ip },
        {}
      ),
      /ERR_TFA_INCORRECT_TOKEN/
    )

    const { fields } = soleRefusal()
    assert.equal(fields.reason, 'tfa-incorrect-code')
    assert.equal(fields.user, 'user-7')
    assert.ok(!JSON.stringify(fields).includes('@'))
  })

  test('logs one info auth login when a session is actually created', async () => {
    installWiki({
      auth: { strategies: { [strategyId]: { module: 'local', config: {} } } },
      models: {
        flags: { authDebug: () => {} },
        rateLimits: { consume: async () => ({ allowed: true, hits: 1, retryAfter: 0 }) },
        auditLog: { record: async () => {} },
        hooks: { emit: async () => {} },
        users: { updateSession: async () => {} }
      },
      db: {
        query: { users: { findFirst: () => Promise.resolve({ groups: [] }) } },
        update: () => ({ set: () => ({ where: async () => {} }) })
      }
    })

    const result = await login.afterLoginChecks(
      { id: 'user-7', email: 'ada@example.com', isActive: true, isVerified: true, auth: {} },
      strategyId,
      { ip, siteId },
      { skipTFA: true, skipChangePwd: true },
      { session: { permissions: [] } }
    )

    assert.equal(result.authenticated, true)
    const logins = info.mock.calls.filter((call: any) => call.arguments[1] === 'login')
    assert.equal(logins.length, 1)
    assert.deepEqual(logins[0].arguments[0], 'auth')
    assert.deepEqual(logins[0].arguments[2], {
      user: 'user-7',
      strategy: strategyId,
      site: siteId
    })
    assert.equal(warn.mock.calls.length, 0, 'a successful login refuses nothing')
  })

  test('twenty wrong passwords from one address are three lines and one summary', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    withStrategy(async () => {
      throw new Error('Invalid password')
    })

    for (let i = 0; i < 20; i += 1) {
      await assert.rejects(
        login.login({ siteId, strategyId, username: 'ada', password: `guess-${i}`, ip }, {})
      )
    }
    assert.equal(warn.mock.calls.length, 3, 'twenty refusals, three lines')

    // -> `authRateLimitWindow: '5m'` is the window the summary closes on.
    mock.timers.tick(300_000)
    const calls = warnCalls()
    assert.equal(calls.length, 4)
    assert.deepEqual(calls[3], ['login refused 20 times in 300s', { ip, strategy: strategyId }])
    mock.timers.reset()
  })

  test('one address burst does not silence another address', async () => {
    withStrategy(async () => {
      throw new Error('Invalid password')
    })

    for (let i = 0; i < 8; i += 1) {
      await assert.rejects(
        login.login({ siteId, strategyId, username: 'ada', password: 'x', ip }, {})
      )
    }
    await assert.rejects(
      login.login({ siteId, strategyId, username: 'grace', password: 'x', ip: '198.51.100.22' }, {})
    )

    assert.deepEqual(
      warnCalls().map(([, fields]) => fields.ip),
      [ip, ip, ip, '198.51.100.22']
    )
  })
})
