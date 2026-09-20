import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { login, LOGIN_REFUSAL_REASONS } from './login.ts'
import { userCredentials } from './userCredentials.ts'
import { auditLog } from './auditLog.ts'
import { createWikiStub, installTestWiki } from '../test/mocks.ts'
import { users } from './users.ts'
import { ProvisionableLoginError } from './authentication.ts'
import { AccountRateLimitedError } from '../helpers/rateLimit.ts'
import { resetCoalesce } from '../helpers/logCoalesce.ts'

/**
 * `CARDINAL.models.groups` is stubbed rather than run against a database: the membership diff is what
 * is under test here, not group persistence.
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
        // -> The real singleton, not a stub: each test mocks `getUserGroupIds` on this same object.
        users
      }
    })
  })

  after(() => wiki.restore())

  // `mappableGroups` defaults to empty, matching the real column: a test exercising a grant or
  // removal has to opt a group into the allow-list explicitly, same as an administrator would.
  function makeStrategy(overrides: Partial<any> = {}): any {
    return {
      id: 'strategy-1',
      module: 'ldap',
      autoEnrollGroups: [],
      mappableGroups: [],
      ...overrides
    }
  }

  /** `systemGroupIds()` keys off `permissions: ['manage:system']`, mirroring the real model. */
  function stubGroups(
    t: any,
    allGroups: Array<{ id: string; name: string; permissions?: string[] }>
  ) {
    const assignUserToGroup = t.mock.fn(async () => true)
    const unassignUserFromGroup = t.mock.fn(async () => true)
    ;(CARDINAL.models as any).groups = {
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
    // -> Both halves of the diff would fire with a full allow-list: the user holds group-reviewers
    //    and the IdP reports Editors.
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

    await login.syncProviderGroups({ id: 'user-1' }, makeStrategy(), ['Editors', 'Reviewers'])

    assert.equal(assignUserToGroup.mock.calls.length, 0)
    assert.equal(unassignUserFromGroup.mock.calls.length, 0)
  })
})

describe('login.loginTFA', () => {
  function makeUser(overrides: Partial<any> = {}): any {
    return { id: 'user-1', email: 'ada@example.com', auth: { strat: {} }, ...overrides }
  }

  let wiki: { restore(): void }

  before(() => {
    wiki = installTestWiki({
      config: { security: {} },
      models: {
        flags: { authDebug: () => {} },
        rateLimits: { consume: async () => ({ allowed: true, hits: 1, retryAfter: 0 }) },
        // -> The real singleton, so the `userCredentials.*` mocks each test installs are the ones
        //    `loginTFA` actually reaches through `CARDINAL.models.userCredentials`.
        userCredentials,
        // -> No-op default so the credential-rejection branches' audit call doesn't throw; its shape
        //    is asserted in the "login outcome logging" suite.
        auditLog: { record: async () => {} }
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

  // -> The typed error is what lets the route handler answer 429, not the generic `ERR_` 400.
  test("a refused account-keyed rate limit throws AccountRateLimitedError with the verdict's retryAfter, before the code is verified", async (t) => {
    const user = makeUser()
    t.mock.method(userCredentials, 'validateToken', async () => ({ user, strategyId: 'strat' }))
    t.mock.method(CARDINAL.models.rateLimits, 'consume', async () => ({
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
 * A form-based module like LDAP verifies the person itself and always signals "this person is real"
 * by throwing `ProvisionableLoginError`, whether or not an account already exists. `autoProvision`
 * means "accepts new users", not "accepts logins", so only `findOrCreateProviderUser()` — stubbed
 * here — may enforce it; `login()`'s dispatch around the catch must not re-check it, or a returning
 * user is refused too.
 */
describe('login.login (form-based provider auto-provisioning)', () => {
  const strategyId = 'strategy-1'

  function makeProfile(overrides: Partial<any> = {}): any {
    return { id: 'ext-1', email: 'ada@example.com', name: 'Ada Lovelace', ...overrides }
  }

  function installWiki(getStrategyById: () => Promise<any>) {
    globalThis.CARDINAL = createWikiStub({
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

  // -> The typed error is what lets `api/auth/site.ts` answer 429, not the generic `ERR_` 400.
  test("a refused account-keyed rate limit throws AccountRateLimitedError with the verdict's retryAfter, before authenticate() runs", async (t) => {
    installWiki(async () => ({ id: strategyId, module: 'ldap', autoProvision: true, config: {} }))
    ;(CARDINAL.models as any).rateLimits.consume = async () => ({
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
 * Defense in depth: the route schema requiring `password` is the first guard against an empty bind
 * on a `useForm` strategy, this is the second, and neither may depend on the other alone.
 */
describe('login.login (empty/missing password guard)', () => {
  const strategyId = 'strategy-1'

  function installWiki(authenticate: () => Promise<any>) {
    globalThis.CARDINAL = createWikiStub({
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
 * The operator-facing log lines, not the audit rows beside them. Each case drives a real refusal
 * branch and reads what the logger stub was called with, so a branch rewired to a different reason
 * — or to no line at all — fails here rather than passing quietly.
 */
describe('login outcome logging', () => {
  const strategyId = 'strategy-1'
  const ip = '203.0.113.11'
  const siteId = 'site-1'

  let warn: ReturnType<typeof mock.fn>
  let info: ReturnType<typeof mock.fn>
  let auditLogRecord: ReturnType<typeof mock.fn>
  let wiki: { restore(): void } | undefined

  const warnCalls = (): Array<[string, any]> =>
    warn.mock.calls.map((call: any) => [call.arguments[1], call.arguments[2]])

  function soleRefusal(): { message: string; fields: any } {
    const calls = warnCalls().filter(([message]) => message === 'login refused')
    assert.equal(calls.length, 1, `expected one refusal line, got ${JSON.stringify(warnCalls())}`)
    return { message: calls[0][0], fields: calls[0][1] }
  }

  function installWiki(overrides: Record<string, any> = {}): void {
    wiki?.restore()
    warn = mock.fn()
    info = mock.fn()
    auditLogRecord = mock.fn(async () => {})
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
        auditLog: { record: auditLogRecord }
      },
      ...overrides
    })
  }

  function withStrategy(authenticate: () => Promise<any>): void {
    installWiki({
      auth: { strategies: { [strategyId]: { module: 'local', authenticate } } }
    })
  }

  beforeEach(() => {
    // -> The coalescing windows are module level, so a burst left over from one case would silence
    //    the next case's first refusal.
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
    ;(CARDINAL as any).models.rateLimits.consume = async () => ({
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

  test('refuses a wrong 2FA code as reason=tfa-incorrect-code, and records a login.failed audit entry', async (t) => {
    // -> A local mock rather than the shared `auditLogRecord` spy: binding to that name here would
    //    capture its value from before the `installWiki()` call below reassigns it, leaving the
    //    assertions pointed at a spy the code under test never calls.
    const auditRecord = mock.fn(async () => {})
    installWiki({
      auth: { strategies: { strat: { module: 'local' } } },
      models: {
        flags: { authDebug: () => {} },
        rateLimits: { consume: async () => ({ allowed: true, hits: 1, retryAfter: 0 }) },
        userCredentials,
        auditLog: { record: auditRecord }
      },
      // -> `countTfaFailure` is a module function, not a method on `userCredentials`, so it cannot
      //    be mocked out; it runs against a `select()` chain answering no rows, its own early return.
      db: {
        select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) })
      }
    })
    const user = {
      id: 'user-7',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      auth: { strat: {} }
    }
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

    // -> Unlike the warn line above, the audit row may carry the account's identity: the
    //    continuation token already proved the password, so this names an already-resolved account
    //    rather than an unauthenticated caller's claim.
    assert.equal(auditRecord.mock.callCount(), 1)
    const entry = (auditRecord.mock.calls[0].arguments as any)[0]
    assert.equal(entry.event, 'login.failed')
    assert.deepEqual(entry.actor, { id: 'user-7', name: 'Ada Lovelace', ip })
    assert.equal(entry.targetType, 'user')
    assert.equal(entry.targetId, 'user-7')
    assert.equal(entry.targetLabel, 'ada@example.com')
    assert.deepEqual(entry.detail, { strategyId: 'strat', reason: 'tfa-incorrect-code' })
    assert.equal(entry.siteId, siteId)
  })

  test('refuses an exhausted recovery code as reason=tfa-recovery-codes-exhausted, and records a login.failed audit entry', async (t) => {
    const auditRecord = mock.fn(async () => {})
    installWiki({
      auth: { strategies: { strat: { module: 'local' } } },
      models: {
        flags: { authDebug: () => {} },
        rateLimits: { consume: async () => ({ allowed: true, hits: 1, retryAfter: 0 }) },
        userCredentials,
        auditLog: { record: auditRecord }
      }
    })
    const user = {
      id: 'user-8',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      auth: { strat: { recoveryCodes: [{ hash: 'x', usedAt: '2024-01-01T00:00:00.000Z' }] } }
    }
    t.mock.method(userCredentials, 'validateToken', async () => ({ user, strategyId: 'strat' }))

    await assert.rejects(
      login.loginTFA(
        {
          strategyId: 'strat',
          siteId,
          securityCode: 'AAAA-BBBB-CCCC-DDDD',
          continuationToken: 'tok',
          ip
        },
        {}
      ),
      /ERR_TFA_RECOVERY_CODES_EXHAUSTED/
    )

    assert.equal(soleRefusal().fields.reason, 'tfa-recovery-codes-exhausted')

    assert.equal(auditRecord.mock.callCount(), 1)
    const entry = (auditRecord.mock.calls[0].arguments as any)[0]
    assert.equal(entry.event, 'login.failed')
    assert.deepEqual(entry.actor, { id: 'user-8', name: 'Ada Lovelace', ip })
    assert.equal(entry.targetType, 'user')
    assert.equal(entry.targetId, 'user-8')
    assert.equal(entry.targetLabel, 'ada@example.com')
    assert.deepEqual(entry.detail, { strategyId: 'strat', reason: 'tfa-recovery-codes-exhausted' })
    assert.equal(entry.siteId, siteId)
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

describe('login self-service audit events', () => {
  const strategyId = 'strategy-1'
  const user = {
    id: 'user-1',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    isActive: true,
    auth: { [strategyId]: { password: 'hash' } },
    prefs: {}
  }

  let record: ReturnType<typeof mock.fn>
  let wiki: { restore(): void }

  beforeEach(() => {
    record = mock.fn(async () => {})
    wiki = installTestWiki({
      logger: { warn: mock.fn(), info: mock.fn(), debug: mock.fn() },
      models: {
        flags: { authDebug: () => {} },
        authentication: {
          getStrategyById: async () => ({
            id: strategyId,
            isEnabled: true,
            config: { allowForgotPassword: true }
          })
        },
        users: { getByEmail: async (email: string) => (email === user.email ? user : null) },
        mail: {
          sendForgotPassword: async () => {},
          sendPasswordResetConfirmed: async () => {}
        },
        userCredentials,
        auditLog: { record }
      }
    })
  })

  afterEach(() => wiki.restore())

  test('forgotPassword records user.passwordResetRequested once a token is minted, with no token in the entry', async (t) => {
    t.mock.method(userCredentials, 'generateToken', async () => 'SECRET-TOKEN')

    await login.forgotPassword({
      strategyId,
      email: 'Ada@Example.com',
      siteId: 'site-1',
      ip: '203.0.113.5'
    })

    assert.equal(record.mock.calls.length, 1)
    const entry = record.mock.calls[0]!.arguments[0] as any
    assert.equal(entry.event, 'user.passwordResetRequested')
    assert.deepEqual(entry.actor, {
      id: 'user-1',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      ip: '203.0.113.5'
    })
    assert.deepEqual(entry.detail, { strategyId })
    assert.ok(!JSON.stringify(entry).includes('SECRET-TOKEN'))
  })

  test('forgotPassword for an unknown address records nothing, so the log cannot be filled with attacker-chosen addresses', async () => {
    await login.forgotPassword({ strategyId, email: 'nobody@example.com', ip: '203.0.113.5' })

    assert.equal(record.mock.calls.length, 0)
  })

  test('resetPassword records user.passwordResetCompleted without the token or the new password', async (t) => {
    t.mock.method(userCredentials, 'validateToken', async () => ({ user, strategyId }))
    t.mock.method(userCredentials, 'patchStrategyAuth', async () => {})
    t.mock.method(login, 'afterLoginChecks', async () => ({
      nextAction: 'redirect',
      redirect: '/'
    }))

    await login.resetPassword(
      {
        strategyId,
        siteId: 'site-1',
        token: 'SECRET-TOKEN',
        newPassword: 'hunter2hunter2',
        ip: '203.0.113.6'
      },
      {}
    )

    assert.equal(record.mock.calls.length, 1)
    const entry = record.mock.calls[0]!.arguments[0] as any
    assert.equal(entry.event, 'user.passwordResetCompleted')
    assert.equal(entry.actor.email, 'ada@example.com')
    assert.equal(entry.actor.ip, '203.0.113.6')
    const serialised = JSON.stringify(entry)
    assert.ok(!serialised.includes('SECRET-TOKEN'))
    assert.ok(!serialised.includes('hunter2hunter2'))
  })

  test('a failing audit write does not fail the reset', async (t) => {
    wiki.restore()
    wiki = installTestWiki({
      logger: { warn: mock.fn(), info: mock.fn(), debug: mock.fn() },
      db: {
        insert: () => ({
          values: async () => {
            throw new Error('db down')
          }
        })
      },
      models: {
        flags: { authDebug: () => {} },
        mail: { sendPasswordResetConfirmed: async () => {} },
        userCredentials,
        auditLog
      }
    })
    t.mock.method(userCredentials, 'validateToken', async () => ({ user, strategyId }))
    t.mock.method(userCredentials, 'patchStrategyAuth', async () => {})
    t.mock.method(login, 'afterLoginChecks', async () => ({
      nextAction: 'redirect',
      redirect: '/'
    }))

    const result = await login.resetPassword(
      { strategyId, siteId: 'site-1', token: 't', newPassword: 'hunter2hunter2' },
      {}
    )

    assert.equal(result.nextAction, 'redirect')
  })
})
