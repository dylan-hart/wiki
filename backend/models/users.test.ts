import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { matchRecoveryCode, users } from './users.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import type { RecoveryCodeEntry } from './users.ts'

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
 * `matchRecoveryCode` is the constant-time-discipline core of recovery-code verification, split out
 * of `verifyAndConsumeRecoveryCode` precisely so it can be tested without `WIKI` or a database: given
 * a set of stored entries and a normalized code, which one (if any) matches. Hashed with a low
 * `bcrypt` cost here purely for test speed — the function itself takes whatever cost is baked into
 * each stored hash, same as production.
 */
describe('users.matchRecoveryCode', () => {
  async function makeEntries(
    codes: string[],
    usedIndexes: number[] = []
  ): Promise<RecoveryCodeEntry[]> {
    return Promise.all(
      codes.map(async (code, i) => ({
        hash: await bcrypt.hash(code, 4),
        usedAt: usedIndexes.includes(i) ? '2024-01-01T00:00:00.000Z' : null
      }))
    )
  }

  test('matches the entry whose hash corresponds to the code', async () => {
    const entries = await makeEntries(['AAAA1111', 'BBBB2222', 'CCCC3333'])
    assert.equal(await matchRecoveryCode(entries, 'BBBB2222'), 1)
  })

  test('returns -1 when no unconsumed entry matches', async () => {
    const entries = await makeEntries(['AAAA1111', 'BBBB2222'])
    assert.equal(await matchRecoveryCode(entries, 'ZZZZ9999'), -1)
  })

  test('skips an already-consumed entry even when the code matches it', async () => {
    const entries = await makeEntries(['AAAA1111', 'BBBB2222'], [0])
    assert.equal(await matchRecoveryCode(entries, 'AAAA1111'), -1)
  })

  test('checks every unconsumed entry rather than stopping at the first non-match', async () => {
    const entries = await makeEntries(['AAAA1111', 'BBBB2222', 'CCCC3333', 'DDDD4444'])
    assert.equal(await matchRecoveryCode(entries, 'DDDD4444'), 3)
  })

  test('an empty set never matches', async () => {
    assert.equal(await matchRecoveryCode([], 'AAAA1111'), -1)
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
describe('users.loginTFA', () => {
  function makeUser(overrides: Partial<any> = {}): any {
    return { id: 'user-1', email: 'ada@example.com', auth: { strat: {} }, ...overrides }
  }

  test('rejects a code shaped like neither a TOTP code nor a recovery code, before validating the token', async (t) => {
    const validateToken = t.mock.method(users, 'validateToken', async () => {
      throw new Error('should not be called')
    })

    await assert.rejects(
      users.loginTFA(
        { strategyId: 'strat', siteId: 'site-1', securityCode: 'nope', continuationToken: 'tok' },
        {}
      ),
      /ERR_TFA_INVALID_REQUEST/
    )
    assert.equal(validateToken.mock.callCount(), 0)
  })

  test('rejects a recovery code submitted to complete a setup login', async (t) => {
    const validateToken = t.mock.method(users, 'validateToken', async () => {
      throw new Error('should not be called')
    })

    await assert.rejects(
      users.loginTFA(
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
      users.loginTFA(
        { strategyId: 'strat', siteId: 'site-1', securityCode: '123456', continuationToken: '' },
        {}
      ),
      /ERR_TFA_INVALID_REQUEST/
    )
  })

  test('a 6-digit code is routed to verifyTfaCode, not verifyAndConsumeRecoveryCode', async (t) => {
    const user = makeUser()
    t.mock.method(users, 'validateToken', async () => ({ user, strategyId: 'strat' }))
    const verifyTfaCode = t.mock.method(users, 'verifyTfaCode', () => true)
    const verifyRecovery = t.mock.method(users, 'verifyAndConsumeRecoveryCode', async () => false)
    t.mock.method(users, 'destroyToken', async () => {})
    t.mock.method(users, 'afterLoginChecks', async () => ({
      nextAction: 'redirect',
      redirect: '/'
    }))

    const result = await users.loginTFA(
      { strategyId: 'strat', siteId: 'site-1', securityCode: '123456', continuationToken: 'tok' },
      {}
    )

    assert.equal(verifyTfaCode.mock.callCount(), 1)
    assert.equal(verifyRecovery.mock.callCount(), 0)
    assert.equal(result.nextAction, 'redirect')
  })

  test('a dash-shaped code is routed to verifyAndConsumeRecoveryCode, not verifyTfaCode', async (t) => {
    const user = makeUser({
      auth: { strat: { recoveryCodes: [{ hash: 'x', usedAt: null }] } }
    })
    t.mock.method(users, 'validateToken', async () => ({ user, strategyId: 'strat' }))
    const verifyTfaCode = t.mock.method(users, 'verifyTfaCode', () => false)
    const verifyRecovery = t.mock.method(users, 'verifyAndConsumeRecoveryCode', async () => true)
    t.mock.method(users, 'destroyToken', async () => {})
    t.mock.method(users, 'afterLoginChecks', async () => ({
      nextAction: 'redirect',
      redirect: '/'
    }))

    await users.loginTFA(
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
    t.mock.method(users, 'validateToken', async () => ({ user, strategyId: 'strat' }))
    const verifyRecovery = t.mock.method(users, 'verifyAndConsumeRecoveryCode', async () => true)

    await assert.rejects(
      users.loginTFA(
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
    t.mock.method(users, 'validateToken', async () => ({ user, strategyId: 'strat' }))
    const verifyRecovery = t.mock.method(users, 'verifyAndConsumeRecoveryCode', async () => true)
    t.mock.method(users, 'destroyToken', async () => {})
    t.mock.method(users, 'afterLoginChecks', async () => ({
      nextAction: 'redirect',
      redirect: '/'
    }))

    const result = await users.loginTFA(
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
    t.mock.method(users, 'validateToken', async () => ({ user, strategyId: 'strat' }))
    t.mock.method(users, 'verifyTfaCode', () => true)
    t.mock.method(users, 'destroyToken', async () => {})
    t.mock.method(users, 'enableTfa', async () => ['CODE-1111', 'CODE-2222'])
    t.mock.method(users, 'afterLoginChecks', async () => ({
      nextAction: 'redirect',
      redirect: '/'
    }))

    const result = await users.loginTFA(
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
    t.mock.method(users, 'validateToken', async () => ({ user, strategyId: 'strat' }))
    t.mock.method(users, 'verifyTfaCode', () => true)
    t.mock.method(users, 'destroyToken', async () => {})
    t.mock.method(users, 'afterLoginChecks', async () => ({
      nextAction: 'redirect',
      redirect: '/'
    }))

    const result = await users.loginTFA(
      { strategyId: 'strat', siteId: 'site-1', securityCode: '123456', continuationToken: 'tok' },
      {}
    )

    assert.equal('recoveryCodes' in result, false)
  })

  test('rejects a submission whose strategyId does not match the one the token was issued for', async (t) => {
    const user = makeUser()
    t.mock.method(users, 'validateToken', async () => ({
      user,
      strategyId: 'a-different-strategy'
    }))

    await assert.rejects(
      users.loginTFA(
        { strategyId: 'strat', siteId: 'site-1', securityCode: '123456', continuationToken: 'tok' },
        {}
      ),
      /ERR_INVALID_STRATEGY/
    )
  })
})

/**
 * `enableTfa`/`verifyAndConsumeRecoveryCode`/`regenerateRecoveryCodes`/`getRecoveryCodesStatus` are
 * thin persistence wrappers around `issueRecoveryCodes()` and `matchRecoveryCode()` (both covered
 * above without a database) — but the wrapping itself, a JSONB `auth` blob round-tripping through a
 * real update/select, is exactly the kind of thing a query-builder mock would just be re-describing.
 * This suite runs the real methods against a migrated, per-run-fresh database (see `test/db.ts`).
 */
describe('users recovery codes (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let usersModel: typeof import('./users.ts').users

  before(async () => {
    fixtures = await setupTestDb()
    ;({ users: usersModel } = await import('./users.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  /** A fresh, otherwise-unused strategy key each test can enable/consume/regenerate against. */
  function freshStrategyId(): string {
    return `strategy-${Math.random().toString(36).slice(2)}`
  }

  test('enableTfa issues RECOVERY_CODE_COUNT distinct codes and stores only their hashes', async () => {
    const strategyId = freshStrategyId()
    const user = await usersModel.getById(fixtures.userId)
    const recoveryCodes = await usersModel.enableTfa(user, strategyId)

    assert.equal(recoveryCodes.length, 10)
    assert.equal(new Set(recoveryCodes).size, 10)

    const reloaded = (await usersModel.getById(fixtures.userId)) as any
    const entries = reloaded.auth[strategyId].recoveryCodes as RecoveryCodeEntry[]
    assert.equal(entries.length, 10)
    for (const entry of entries) {
      assert.equal(entry.usedAt, null)
      assert.ok(!recoveryCodes.includes(entry.hash))
    }
  })

  test('verifyAndConsumeRecoveryCode accepts an issued code once, then rejects it on a second try', async () => {
    const strategyId = freshStrategyId()
    const owner = await usersModel.getById(fixtures.userId)
    const [code] = await usersModel.enableTfa(owner, strategyId)

    const firstAttempt = await usersModel.getById(fixtures.userId)
    assert.equal(
      await usersModel.verifyAndConsumeRecoveryCode(firstAttempt, strategyId, code!),
      true
    )

    const secondAttempt = await usersModel.getById(fixtures.userId)
    assert.equal(
      await usersModel.verifyAndConsumeRecoveryCode(secondAttempt, strategyId, code!),
      false
    )
  })

  test('verifyAndConsumeRecoveryCode rejects a code that was never issued', async () => {
    const strategyId = freshStrategyId()
    const owner = await usersModel.getById(fixtures.userId)
    await usersModel.enableTfa(owner, strategyId)

    const user = await usersModel.getById(fixtures.userId)
    assert.equal(
      await usersModel.verifyAndConsumeRecoveryCode(user, strategyId, 'ZZZZ-ZZZZ-ZZZZ-ZZZZ'),
      false
    )
  })

  test('getRecoveryCodesStatus reports total/remaining and drops by one per consumed code', async () => {
    const strategyId = freshStrategyId()
    const owner = await usersModel.getById(fixtures.userId)
    const codes = await usersModel.enableTfa(owner, strategyId)

    const before = await usersModel.getRecoveryCodesStatus(fixtures.userId, strategyId)
    assert.deepEqual(before, { total: 10, remaining: 10 })

    const consumer = await usersModel.getById(fixtures.userId)
    await usersModel.verifyAndConsumeRecoveryCode(consumer, strategyId, codes[0]!)

    const after = await usersModel.getRecoveryCodesStatus(fixtures.userId, strategyId)
    assert.deepEqual(after, { total: 10, remaining: 9 })
  })

  test('getRecoveryCodesStatus throws ERR_INVALID_STRATEGY for a strategy the user has no entry for', async () => {
    await assert.rejects(
      usersModel.getRecoveryCodesStatus(fixtures.userId, freshStrategyId()),
      /ERR_INVALID_STRATEGY/
    )
  })

  test('getRecoveryCodesStatus throws ERR_TFA_NOT_ACTIVE for a secret that was generated but never activated', async () => {
    const strategyId = freshStrategyId()
    const user = await usersModel.getById(fixtures.userId)
    await usersModel.startTfaSetup(user, strategyId, fixtures.siteId)

    await assert.rejects(
      usersModel.getRecoveryCodesStatus(fixtures.userId, strategyId),
      /ERR_TFA_NOT_ACTIVE/
    )
  })

  test('regenerateRecoveryCodes replaces the whole set and reports whether unused codes were thrown away', async () => {
    const strategyId = freshStrategyId()
    const owner = await usersModel.getById(fixtures.userId)
    const original = await usersModel.enableTfa(owner, strategyId)

    const { recoveryCodes: fresh, hadUnusedCodes } = await usersModel.regenerateRecoveryCodes(
      fixtures.userId,
      strategyId
    )
    assert.equal(hadUnusedCodes, true)
    assert.equal(fresh.length, 10)
    assert.equal(
      fresh.some((code) => original.includes(code)),
      false
    )

    // -> A code from the set that was just replaced no longer works, even though it was never used.
    const user = await usersModel.getById(fixtures.userId)
    assert.equal(
      await usersModel.verifyAndConsumeRecoveryCode(user, strategyId, original[0]!),
      false
    )
  })

  test('regenerateRecoveryCodes reports hadUnusedCodes false once every prior code was already spent', async () => {
    const strategyId = freshStrategyId()
    const owner = await usersModel.getById(fixtures.userId)
    const codes = await usersModel.enableTfa(owner, strategyId)
    // -> Every issued code gets consumed one by one, since each attempt needs a freshly-reloaded user.
    for (const code of codes) {
      const consumer = await usersModel.getById(fixtures.userId)
      assert.equal(await usersModel.verifyAndConsumeRecoveryCode(consumer, strategyId, code), true)
    }

    const { hadUnusedCodes } = await usersModel.regenerateRecoveryCodes(fixtures.userId, strategyId)
    assert.equal(hadUnusedCodes, false)
  })

  test('regenerateRecoveryCodes throws ERR_TFA_NOT_ACTIVE for a secret that was generated but never activated', async () => {
    const strategyId = freshStrategyId()
    const user = await usersModel.getById(fixtures.userId)
    await usersModel.startTfaSetup(user, strategyId, fixtures.siteId)

    await assert.rejects(
      usersModel.regenerateRecoveryCodes(fixtures.userId, strategyId),
      /ERR_TFA_NOT_ACTIVE/
    )
  })

  test('disableTfa clears recovery codes, so a code from the old set never works after 2FA is re-enabled', async () => {
    const strategyId = freshStrategyId()
    const owner = await usersModel.getById(fixtures.userId)
    const [oldCode] = await usersModel.enableTfa(owner, strategyId)

    await usersModel.disableTfa(fixtures.userId, strategyId)

    const reEnabled = await usersModel.getById(fixtures.userId)
    await usersModel.enableTfa(reEnabled, strategyId)

    const user = await usersModel.getById(fixtures.userId)
    assert.equal(await usersModel.verifyAndConsumeRecoveryCode(user, strategyId, oldCode!), false)
  })
})
