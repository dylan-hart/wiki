import { after, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import { matchRecoveryCode, users } from './users.ts'
import {
  hasTestDatabase,
  seedLocale,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../test/db.ts'
import {
  assets as assetsTable,
  authentication as authenticationTable,
  pages as pagesTable,
  userKeys,
  users as usersTable
} from '../db/schema.ts'
import type { RecoveryCodeEntry } from './users.ts'
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
        cvd: 'none',
        locale: 'fr'
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
      cvd: 'none',
      locale: 'fr'
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
 * Minimal stand-in for the subset of `Temporal` that `generateToken()` and `validateToken()` call
 * between them: `Now.instant()`, `.add()`, `.toString({ smallestUnit })` on the write side, plus
 * `Instant.compare()` and `Date.prototype.toTemporalInstant()` on the read side (`validateToken()`
 * compares against the `Date` drizzle hands back for the `timestamp` column).
 *
 * CLAUDE.md documents `Temporal` as a Node 26 global needing no import, but this sandbox's `node` is
 * v25.9.0, which doesn't expose it (same environment gap `core/scheduler.test.ts` works around, not
 * a spec deviation). Shared at module scope, not local to one `describe`, since both the register and
 * the forgot/reset-password suites below exercise `generateToken()`, and the latter also exercises
 * `validateToken()`.
 */
function installFakeTemporal(): void {
  const durationToMs = (d: { hours?: number }) => (d.hours ?? 0) * 3_600_000
  const makeInstant = (epochMs: number): any => ({
    epochMilliseconds: epochMs,
    add: (d: any) => makeInstant(epochMs + durationToMs(d)),
    toString: () => new Date(epochMs).toISOString()
  })
  ;(globalThis as any).Temporal = {
    Now: { instant: () => makeInstant(Date.now()) },
    Instant: {
      compare: (a: any, b: any) =>
        a.epochMilliseconds < b.epochMilliseconds
          ? -1
          : a.epochMilliseconds > b.epochMilliseconds
            ? 1
            : 0,
      from: (s: string) => makeInstant(new Date(s).getTime())
    }
  }
  ;(Date.prototype as any).toTemporalInstant = function (this: Date) {
    return makeInstant(this.getTime())
  }
}

/** Undoes `installFakeTemporal()`'s `Date.prototype` patch, alongside restoring `globalThis.Temporal`. */
function uninstallFakeTemporal(previousTemporal: any): void {
  ;(globalThis as any).Temporal = previousTemporal
  delete (Date.prototype as any).toTemporalInstant
}

/**
 * `register()` is SQL orchestration -- a strategy lookup, an existence check, then coordinating the
 * `users`, `userGroups` and `userKeys` tables -- so this runs the real method against a migrated,
 * per-run-fresh database (see `test/db.ts`), the same DB-backed pattern `models/pages.test.ts` uses.
 * `mail.sendVerifyEmail` is stubbed rather than pulling in a real SMTP transport, matching how
 * `api/mail.test.ts` isolates the route it covers from `models/mail.test.ts`'s own coverage of that
 * mapping.
 */
describe('users.register (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let sendVerifyEmailMock: ReturnType<typeof mock.fn>
  let previousTemporal: any

  const MODULE_KEY = 'local-test'

  function req(): any {
    return { session: {} }
  }

  async function createStrategy({
    registration = true,
    allowedEmailRegex = '',
    autoEnrollGroups = [] as string[],
    emailValidation = true,
    isEnabled = true
  } = {}): Promise<string> {
    const [row] = await fixtures.db
      .insert(authenticationTable)
      .values({
        module: MODULE_KEY,
        isEnabled,
        displayName: 'Test Local',
        registration,
        allowedEmailRegex,
        autoEnrollGroups,
        config: { emailValidation }
      })
      .returning({ id: authenticationTable.id })
    return row!.id
  }

  /**
   * `afterLoginChecks()` (reached only when `emailValidation` is off) looks the strategy up in
   * `WIKI.auth.strategies`, not the database -- that is where a strategy's live module instance
   * lives, and `enforceTfa` is read off it. A bare stand-in is enough: nothing under test needs it to
   * be a real module instance, just present.
   */
  function registerLiveStrategy(strategyId: string, config: Record<string, any> = {}): void {
    ;(WIKI.auth.strategies as any)[strategyId] = { config }
  }

  before(async () => {
    previousTemporal = (globalThis as any).Temporal
    installFakeTemporal()

    fixtures = await setupTestDb()
    const { mail } = await import('./mail.ts')
    sendVerifyEmailMock = mock.method(mail, 'sendVerifyEmail', async () => {})

    WIKI.data.authentication = [
      {
        key: MODULE_KEY,
        title: 'Test Local',
        description: '',
        isAvailable: true,
        useForm: true,
        usernameType: 'email',
        props: {
          emailValidation: { type: 'Boolean', title: 'Email Validation', default: true }
        }
      }
    ] as any
    // -> `getActiveStrategies()` reads this unconditionally (to sort the built-in local strategy
    //    first), regardless of which test strategy is under test; the creation tests below override it
    //    to their own strategy id, since that is the key `createUser()` stores the password blob under.
    WIKI.data.systemIds = { localAuthId: 'placeholder-local-auth-id' } as any
  })

  after(async () => {
    mock.restoreAll()
    await teardownTestDb()
    uninstallFakeTemporal(previousTemporal)
  })

  beforeEach(() => {
    sendVerifyEmailMock.mock.resetCalls()
  })

  test('refuses an unknown strategy id', async () => {
    await assert.rejects(
      users.register(
        {
          siteId: fixtures.siteId,
          strategyId: '00000000-0000-0000-0000-000000000000',
          name: 'Nobody',
          email: 'nobody@example.com',
          password: 'longenough1'
        },
        req()
      ),
      /ERR_INVALID_STRATEGY/
    )
  })

  test('refuses when the strategy does not accept new users', async () => {
    const strategyId = await createStrategy({ registration: false })

    await assert.rejects(
      users.register(
        {
          siteId: fixtures.siteId,
          strategyId,
          name: 'Ada Lovelace',
          email: 'ada.closed@example.com',
          password: 'longenough1'
        },
        req()
      ),
      /ERR_REGISTRATION_DISABLED/
    )
  })

  test('refuses an address outside allowedEmailRegex', async () => {
    const strategyId = await createStrategy({ allowedEmailRegex: '^[^@]+@allowed\\.example$' })

    await assert.rejects(
      users.register(
        {
          siteId: fixtures.siteId,
          strategyId,
          name: 'Ada Lovelace',
          email: 'ada@elsewhere.example',
          password: 'longenough1'
        },
        req()
      ),
      /ERR_EMAIL_NOT_ALLOWED/
    )
  })

  test('refuses a duplicate of an already-verified address', async () => {
    const strategyId = await createStrategy()

    await assert.rejects(
      users.register(
        {
          siteId: fixtures.siteId,
          strategyId,
          name: 'Fixture User',
          // -> setupTestDb() seeds this address already verified
          email: 'fixture@example.com',
          password: 'longenough1'
        },
        req()
      ),
      /ERR_EMAIL_ALREADY_EXISTS/
    )
    assert.equal(sendVerifyEmailMock.mock.calls.length, 0)
  })

  test('emailValidation on: creates an unverified account and emails a verification link, without logging in', async () => {
    const strategyId = await createStrategy({ emailValidation: true })
    WIKI.data.systemIds = { localAuthId: strategyId } as any
    const request = req()

    const result = await users.register(
      {
        siteId: fixtures.siteId,
        strategyId,
        name: 'Grace Hopper',
        email: 'Grace.Hopper@Example.com',
        password: 'longenough1'
      },
      request
    )

    assert.deepEqual(result, { nextAction: 'verify' })
    assert.equal(request.session.authenticated, undefined)

    const created = await users.getByEmail('grace.hopper@example.com')
    assert.ok(created)
    assert.equal(created!.isVerified, false)

    assert.equal(sendVerifyEmailMock.mock.calls.length, 1)
    const call = sendVerifyEmailMock.mock.calls[0].arguments[0] as any
    assert.equal(call.to, 'grace.hopper@example.com')
    assert.equal(call.name, 'Grace Hopper')
    assert.ok(call.token)

    const [tokenRow] = await fixtures.db
      .select()
      .from(userKeys)
      .where(eq(userKeys.token, call.token))
    assert.ok(tokenRow)
    assert.equal(tokenRow!.kind, 'verify')
    assert.equal(tokenRow!.userId, created!.id)
  })

  test('emailValidation off: logs the new account straight in, like every other successful auth path', async () => {
    const strategyId = await createStrategy({ emailValidation: false })
    WIKI.data.systemIds = { localAuthId: strategyId } as any
    registerLiveStrategy(strategyId)
    const request = req()

    const result = await users.register(
      {
        siteId: fixtures.siteId,
        strategyId,
        name: 'Alan Turing',
        email: 'alan@example.com',
        password: 'longenough1'
      },
      request
    )

    assert.equal(result.authenticated, true)
    assert.equal(result.nextAction, 'redirect')
    assert.equal(request.session.authenticated, true)

    const created = await users.getByEmail('alan@example.com')
    assert.ok(created)
    assert.equal(created!.isVerified, true)
    assert.equal(sendVerifyEmailMock.mock.calls.length, 0)
  })

  test('enrolls a new account into the strategy autoEnrollGroups', async () => {
    const strategyId = await createStrategy({
      emailValidation: false,
      autoEnrollGroups: [fixtures.groupId]
    })
    WIKI.data.systemIds = { localAuthId: strategyId } as any
    registerLiveStrategy(strategyId)

    await users.register(
      {
        siteId: fixtures.siteId,
        strategyId,
        name: 'Margaret Hamilton',
        email: 'margaret@example.com',
        password: 'longenough1'
      },
      req()
    )

    const created = await users.getByEmail('margaret@example.com')
    const groupIds = await users.getUserGroupIds(created!.id)
    assert.deepEqual(groupIds, [fixtures.groupId])
  })

  test('re-registering a still-unverified address resends the link for the same account instead of creating a duplicate', async () => {
    const strategyId = await createStrategy({ emailValidation: true })
    WIKI.data.systemIds = { localAuthId: strategyId } as any

    const first = await users.register(
      {
        siteId: fixtures.siteId,
        strategyId,
        name: 'First Name',
        email: 'pending@example.com',
        password: 'firstpassword1'
      },
      req()
    )
    assert.deepEqual(first, { nextAction: 'verify' })
    assert.equal(sendVerifyEmailMock.mock.calls.length, 1)

    const second = await users.register(
      {
        siteId: fixtures.siteId,
        strategyId,
        name: 'Second Name',
        email: 'pending@example.com',
        password: 'secondpassword2'
      },
      req()
    )
    assert.deepEqual(second, { nextAction: 'verify' })

    // -> Resent, not refused
    assert.equal(sendVerifyEmailMock.mock.calls.length, 2)
    const secondCall = sendVerifyEmailMock.mock.calls[1].arguments[0] as any
    // -> The resend goes to the original account: its name, not the second attempt's
    assert.equal(secondCall.name, 'First Name')

    const rows = await fixtures.db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, 'pending@example.com'))
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.name, 'First Name')
  })
})

/**
 * `forgotPassword()` and `resetPassword()` are also SQL orchestration -- a strategy/config lookup, a
 * user lookup, and a token round-trip through `userKeys` -- so this runs the real methods the same
 * DB-backed way `register()`'s suite above does. `mail.sendForgotPassword` and
 * `sendPasswordResetConfirmed` are stubbed for the same reason `sendVerifyEmail` is above: no real
 * SMTP transport is needed to test this orchestration.
 */
describe('users.forgotPassword / resetPassword (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let sendForgotPasswordMock: ReturnType<typeof mock.fn>
  let sendPasswordResetConfirmedMock: ReturnType<typeof mock.fn>
  let previousTemporal: any

  const MODULE_KEY = 'local-reset-test'

  function req(): any {
    return { session: {} }
  }

  async function createStrategy({
    isEnabled = true,
    allowForgotPassword = true
  }: { isEnabled?: boolean; allowForgotPassword?: boolean } = {}): Promise<string> {
    const [row] = await fixtures.db
      .insert(authenticationTable)
      .values({
        module: MODULE_KEY,
        isEnabled,
        displayName: 'Test Local Reset',
        registration: true,
        allowedEmailRegex: '',
        autoEnrollGroups: [],
        config: { allowForgotPassword }
      })
      .returning({ id: authenticationTable.id })
    return row!.id
  }

  /**
   * Same reasoning as the register suite's own copy above: `afterLoginChecks()` looks the strategy up
   * in `WIKI.auth.strategies`, not the database.
   */
  function registerLiveStrategy(strategyId: string, config: Record<string, any> = {}): void {
    ;(WIKI.auth.strategies as any)[strategyId] = { config }
  }

  async function createLocalUser(
    strategyId: string,
    {
      email,
      name = 'Reset Target',
      password = 'originalpwd1'
    }: { email: string; name?: string; password?: string }
  ): Promise<string> {
    WIKI.data.systemIds = { localAuthId: strategyId } as any
    return users.createUser({ name, email, password, isVerified: true })
  }

  before(async () => {
    previousTemporal = (globalThis as any).Temporal
    installFakeTemporal()

    fixtures = await setupTestDb()
    const { mail } = await import('./mail.ts')
    sendForgotPasswordMock = mock.method(mail, 'sendForgotPassword', async () => {})
    sendPasswordResetConfirmedMock = mock.method(mail, 'sendPasswordResetConfirmed', async () => {})

    WIKI.data.authentication = [
      {
        key: MODULE_KEY,
        title: 'Test Local Reset',
        description: '',
        isAvailable: true,
        useForm: true,
        usernameType: 'email',
        props: {
          // -> Matches `modules/authentication/local/definition.yml`'s own prop: default true
          allowForgotPassword: { type: 'Boolean', title: 'Allow Forgot Password', default: true }
        }
      }
    ] as any
  })

  after(async () => {
    mock.restoreAll()
    await teardownTestDb()
    uninstallFakeTemporal(previousTemporal)
  })

  beforeEach(() => {
    sendForgotPasswordMock.mock.resetCalls()
    sendPasswordResetConfirmedMock.mock.resetCalls()
  })

  describe('forgotPassword', () => {
    test('an unknown strategy id sends nothing and does not throw', async () => {
      await users.forgotPassword({
        strategyId: '00000000-0000-0000-0000-000000000000',
        email: 'nobody@example.com'
      })
      assert.equal(sendForgotPasswordMock.mock.calls.length, 0)
    })

    test('a strategy with allowForgotPassword off sends nothing', async () => {
      const strategyId = await createStrategy({ allowForgotPassword: false })
      await createLocalUser(strategyId, { email: 'off@example.com' })

      await users.forgotPassword({ strategyId, email: 'off@example.com' })

      assert.equal(sendForgotPasswordMock.mock.calls.length, 0)
    })

    test('an email matching no account sends nothing', async () => {
      const strategyId = await createStrategy()

      await users.forgotPassword({ strategyId, email: 'nosuchaccount@example.com' })

      assert.equal(sendForgotPasswordMock.mock.calls.length, 0)
    })

    test('a matching account with no password under this strategy sends nothing', async () => {
      const strategyId = await createStrategy()
      const otherStrategyId = await createStrategy()
      await createLocalUser(otherStrategyId, { email: 'elsewhere@example.com' })

      await users.forgotPassword({ strategyId, email: 'elsewhere@example.com' })

      assert.equal(sendForgotPasswordMock.mock.calls.length, 0)
    })

    test('a strategy that allows resets and a matching account: generates a resetPwd token and emails it', async () => {
      const strategyId = await createStrategy({ allowForgotPassword: true })
      const userId = await createLocalUser(strategyId, {
        email: 'wants-reset@example.com',
        name: 'Wants Reset'
      })

      await users.forgotPassword({ strategyId, email: 'Wants-Reset@Example.com' })

      assert.equal(sendForgotPasswordMock.mock.calls.length, 1)
      const call = sendForgotPasswordMock.mock.calls[0].arguments[0] as any
      assert.equal(call.to, 'wants-reset@example.com')
      assert.equal(call.name, 'Wants Reset')
      assert.ok(call.token)

      const [tokenRow] = await fixtures.db
        .select()
        .from(userKeys)
        .where(eq(userKeys.token, call.token))
      assert.ok(tokenRow)
      assert.equal(tokenRow!.kind, 'resetPwd')
      assert.equal(tokenRow!.userId, userId)
      assert.deepEqual(tokenRow!.meta, { strategyId })
    })
  })

  describe('resetPassword', () => {
    test('rejects a password under 8 characters before touching the token', async () => {
      await assert.rejects(
        users.resetPassword(
          {
            siteId: fixtures.siteId,
            strategyId: 'irrelevant',
            token: 'irrelevant',
            newPassword: 'short'
          },
          req()
        ),
        /ERR_PASSWORD_TOO_SHORT/
      )
    })

    test('rejects an unknown token', async () => {
      await assert.rejects(
        users.resetPassword(
          {
            siteId: fixtures.siteId,
            strategyId: 'irrelevant',
            token: 'not-a-real-token',
            newPassword: 'longenough1'
          },
          req()
        ),
        /ERR_INVALID_VALIDATION_TOKEN/
      )
    })

    test('rejects a strategy id that does not match the token', async () => {
      const strategyId = await createStrategy()
      const userId = await createLocalUser(strategyId, { email: 'mismatch@example.com' })
      const token = await users.generateToken({ kind: 'resetPwd', userId, meta: { strategyId } })

      await assert.rejects(
        users.resetPassword(
          {
            siteId: fixtures.siteId,
            strategyId: '00000000-0000-0000-0000-000000000000',
            token,
            newPassword: 'longenough1'
          },
          req()
        ),
        /ERR_INVALID_STRATEGY/
      )
    })

    test('sets the new password, sends the confirmation email, and logs the account straight in', async () => {
      const strategyId = await createStrategy()
      registerLiveStrategy(strategyId)
      const userId = await createLocalUser(strategyId, {
        email: 'confirm@example.com',
        name: 'Confirm Me',
        password: 'originalpwd1'
      })
      const token = await users.generateToken({ kind: 'resetPwd', userId, meta: { strategyId } })
      const request = req()

      const result = await users.resetPassword(
        { siteId: fixtures.siteId, strategyId, token, newPassword: 'brandnewpwd1' },
        request
      )

      assert.equal(result.authenticated, true)
      assert.equal(result.nextAction, 'redirect')
      assert.equal(request.session.authenticated, true)

      const [row] = await fixtures.db.select().from(usersTable).where(eq(usersTable.id, userId))
      const auth = (row!.auth as Record<string, any>)[strategyId]
      assert.equal(await bcrypt.compare('brandnewpwd1', auth.password), true)
      assert.equal(auth.mustChangePwd, false)

      assert.equal(sendPasswordResetConfirmedMock.mock.calls.length, 1)
      const confirmCall = sendPasswordResetConfirmedMock.mock.calls[0].arguments[0] as any
      assert.equal(confirmCall.to, 'confirm@example.com')

      // -> Single-use: the token is gone after a successful reset
      const [tokenRow] = await fixtures.db.select().from(userKeys).where(eq(userKeys.token, token))
      assert.equal(tokenRow, undefined)
    })

    test('an account with 2FA active is not logged straight in -- a code is still required first', async () => {
      const strategyId = await createStrategy()
      registerLiveStrategy(strategyId)
      const userId = await createLocalUser(strategyId, { email: 'has-2fa@example.com' })

      const [before] = await fixtures.db.select().from(usersTable).where(eq(usersTable.id, userId))
      const auth = before!.auth as Record<string, any>
      auth[strategyId].tfaIsActive = true
      auth[strategyId].tfaSecret = 'JBSWY3DPEHPK3PXP'
      await fixtures.db.update(usersTable).set({ auth }).where(eq(usersTable.id, userId))

      const token = await users.generateToken({ kind: 'resetPwd', userId, meta: { strategyId } })
      const request = req()

      const result = await users.resetPassword(
        { siteId: fixtures.siteId, strategyId, token, newPassword: 'brandnewpwd1' },
        request
      )

      assert.equal(result.nextAction, 'provideTfa')
      assert.ok(result.continuationToken)
      assert.equal(result.authenticated, undefined)
      assert.equal(request.session.authenticated, undefined)
    })
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

  test('adminInvalidateTfa clears the secret, deactivates 2FA, and drops recovery codes even when tfaRequired is set', async () => {
    const strategyId = freshStrategyId()
    const owner = await usersModel.getById(fixtures.userId)
    await usersModel.enableTfa(owner, strategyId)
    // -> tfaRequired is exactly what disableTfa() refuses to override; an admin doing this on
    //    purpose is the entire point of adminInvalidateTfa. setUserAuthFlags() only ever touches the
    //    local strategy, so the flag is set directly on this (fixture, non-local) strategy's entry.
    const flagged = (await usersModel.getById(fixtures.userId)) as any
    await fixtures.db
      .update(usersTable)
      .set({
        auth: { ...flagged.auth, [strategyId]: { ...flagged.auth[strategyId], tfaRequired: true } }
      })
      .where(eq(usersTable.id, fixtures.userId))

    await usersModel.adminInvalidateTfa(fixtures.userId, strategyId)

    const reloaded = (await usersModel.getById(fixtures.userId)) as any
    assert.equal(reloaded.auth[strategyId].tfaIsActive, false)
    assert.equal(reloaded.auth[strategyId].tfaSecret, '')
    assert.deepEqual(reloaded.auth[strategyId].recoveryCodes, [])
  })

  test('adminInvalidateTfa throws ERR_INVALID_STRATEGY for a strategy the user has no entry for', async () => {
    await assert.rejects(
      usersModel.adminInvalidateTfa(fixtures.userId, freshStrategyId()),
      /ERR_INVALID_STRATEGY/
    )
  })

  test('adminInvalidateTfa throws ERR_TFA_NOT_ACTIVE for a secret that was generated but never activated', async () => {
    const strategyId = freshStrategyId()
    const user = await usersModel.getById(fixtures.userId)
    await usersModel.startTfaSetup(user, strategyId, fixtures.siteId)

    await assert.rejects(
      usersModel.adminInvalidateTfa(fixtures.userId, strategyId),
      /ERR_TFA_NOT_ACTIVE/
    )
  })

  test('adminInvalidateTfa throws ERR_INVALID_USER for a user that does not exist', async () => {
    await assert.rejects(
      usersModel.adminInvalidateTfa('00000000-0000-0000-0000-000000000000', freshStrategyId()),
      /ERR_INVALID_USER/
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

/**
 * `reassignContent`'s three refusals (same user, unknown target, target is a system account) all run
 * before the method ever opens its transaction, off nothing but `getById()`'s return value — so they
 * are tested by mocking that one collaborator, the same way `users.loginTFA`'s suite above mocks its
 * own collaborators, rather than paying for a database connection to prove a branch that never issues
 * a query.
 */
describe('users.reassignContent validation', () => {
  test('refuses to reassign a user onto themselves, without looking the target up', async (t) => {
    const getById = t.mock.method(users, 'getById', async () => {
      throw new Error('should not be called')
    })

    await assert.rejects(users.reassignContent('user-1', 'user-1'), /ERR_REASSIGN_SAME_USER/)
    assert.equal(getById.mock.callCount(), 0)
  })

  test('refuses a target user that does not exist', async (t) => {
    t.mock.method(users, 'getById', async () => null)

    await assert.rejects(users.reassignContent('user-1', 'user-2'), /ERR_INVALID_USER/)
  })

  test('refuses a target user that is a system account', async (t) => {
    t.mock.method(users, 'getById', async () => ({ id: 'user-2', isSystem: true }))

    await assert.rejects(users.reassignContent('user-1', 'user-2'), /ERR_REASSIGN_TARGET_IS_SYSTEM/)
  })
})

/**
 * `reassignContent` is SQL orchestration over two tables inside one transaction — exactly the
 * `models/pages.test.ts`-style case CLAUDE.md calls out for a real database rather than a query
 * builder mock. Pages and assets are seeded with raw inserts (bypassing `pages.createPage()`/the
 * asset upload path entirely) since only the `authorId`/`creatorId`/`ownerId` columns this method
 * touches matter here.
 */
describe('users.reassignContent (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let usersModel: typeof import('./users.ts').users
  let targetUserId: string

  before(async () => {
    fixtures = await setupTestDb()
    ;({ users: usersModel } = await import('./users.ts'))

    const [target] = await fixtures.db
      .insert(usersTable)
      .values({
        email: 'target@example.com',
        name: 'Target User',
        isActive: true,
        isVerified: true
      })
      .returning({ id: usersTable.id })
    targetUserId = target!.id
  })

  after(async () => {
    await teardownTestDb()
  })

  function rawPageRow(overrides: {
    path: string
    authorId: string
    creatorId: string
    ownerId: string
  }) {
    return {
      locale: 'en',
      path: overrides.path,
      hash: `reassign-hash-${overrides.path}`,
      title: 'Reassign Me',
      editor: 'markdown',
      contentType: 'markdown',
      authorId: overrides.authorId,
      creatorId: overrides.creatorId,
      ownerId: overrides.ownerId,
      siteId: fixtures.siteId,
      classification: fixtures.classificationId
    }
  }

  function rawAssetRow(overrides: { fileName: string; authorId: string }) {
    return {
      fileName: overrides.fileName,
      fileExt: 'png',
      authorId: overrides.authorId,
      siteId: fixtures.siteId
    }
  }

  test('reassigns a page that names the departing user in only one of authorId/creatorId/ownerId', async () => {
    const [page] = await fixtures.db
      .insert(pagesTable)
      .values(
        rawPageRow({
          path: 'reassign/single-column',
          authorId: fixtures.userId,
          creatorId: targetUserId,
          ownerId: targetUserId
        })
      )
      .returning()

    const result = await usersModel.reassignContent(fixtures.userId, targetUserId)

    assert.equal(result.pagesReassigned, 1)
    const [reloaded] = await fixtures.db
      .select()
      .from(pagesTable)
      .where(eq(pagesTable.id, page!.id))
    assert.equal(reloaded!.authorId, targetUserId)
    assert.equal(reloaded!.creatorId, targetUserId)
    assert.equal(reloaded!.ownerId, targetUserId)
  })

  test('reassigns a page naming the departing user in all three columns, counted once', async () => {
    const [page] = await fixtures.db
      .insert(pagesTable)
      .values(
        rawPageRow({
          path: 'reassign/all-columns',
          authorId: fixtures.userId,
          creatorId: fixtures.userId,
          ownerId: fixtures.userId
        })
      )
      .returning()

    const result = await usersModel.reassignContent(fixtures.userId, targetUserId)

    assert.equal(result.pagesReassigned, 1)
    const [reloaded] = await fixtures.db
      .select()
      .from(pagesTable)
      .where(eq(pagesTable.id, page!.id))
    assert.equal(reloaded!.authorId, targetUserId)
    assert.equal(reloaded!.creatorId, targetUserId)
    assert.equal(reloaded!.ownerId, targetUserId)
  })

  test('does not touch a page that never named the departing user', async () => {
    const [untouched] = await fixtures.db
      .insert(pagesTable)
      .values(
        rawPageRow({
          path: 'reassign/untouched',
          authorId: targetUserId,
          creatorId: targetUserId,
          ownerId: targetUserId
        })
      )
      .returning()

    await usersModel.reassignContent(fixtures.userId, targetUserId)

    const [reloaded] = await fixtures.db
      .select()
      .from(pagesTable)
      .where(eq(pagesTable.id, untouched!.id))
    assert.equal(reloaded!.authorId, targetUserId)
  })

  test('reassigns every asset the departing user authored', async () => {
    const [asset] = await fixtures.db
      .insert(assetsTable)
      .values(rawAssetRow({ fileName: 'reassign-me.png', authorId: fixtures.userId }))
      .returning()

    const result = await usersModel.reassignContent(fixtures.userId, targetUserId)

    assert.equal(result.assetsReassigned, 1)
    const [reloaded] = await fixtures.db
      .select()
      .from(assetsTable)
      .where(eq(assetsTable.id, asset!.id))
    assert.equal(reloaded!.authorId, targetUserId)
  })

  test('reports zero for both counts when the departing user owns nothing', async () => {
    const [freshUser] = await fixtures.db
      .insert(usersTable)
      .values({
        email: 'nothing-owned@example.com',
        name: 'Nothing Owned',
        isActive: true,
        isVerified: true
      })
      .returning({ id: usersTable.id })

    const result = await usersModel.reassignContent(freshUser!.id, targetUserId)

    assert.deepEqual(result, { pagesReassigned: 0, assetsReassigned: 0 })
  })
})

/**
 * `updateProfile` is the write path for the profile screen's preferences, `users.prefs.locale`
 * (OpenProject #1619) included -- exercised DB-backed since it round-trips through `getById()` /
 * `updateUser()`, and `locale` validation reads the installed locale list through
 * `WIKI.models.locales.getLocales()`.
 */
describe('users.updateProfile (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let usersModel: typeof import('./users.ts').users

  before(async () => {
    fixtures = await setupTestDb()
    ;({ users: usersModel } = await import('./users.ts'))
    await seedLocale(fixtures.db, { code: 'fr' })
  })

  after(async () => {
    await teardownTestDb()
  })

  test('persists a locale naming an installed locale, and reads it back on reload', async () => {
    const updated = await usersModel.updateProfile(fixtures.userId, { locale: 'fr' })
    assert.equal(updated?.locale, 'fr')

    const reloaded = await usersModel.getProfile(fixtures.userId)
    assert.equal(reloaded?.locale, 'fr')
  })

  test('clears the preference on an empty string, without requiring it be installed', async () => {
    await usersModel.updateProfile(fixtures.userId, { locale: 'fr' })

    const cleared = await usersModel.updateProfile(fixtures.userId, { locale: '' })
    assert.equal(cleared?.locale, '')

    const reloaded = await usersModel.getProfile(fixtures.userId)
    assert.equal(reloaded?.locale, '')
  })

  test('rejects a locale code that names no installed locale, leaving the stored preference untouched', async () => {
    await usersModel.updateProfile(fixtures.userId, { locale: 'fr' })

    await assert.rejects(
      () => usersModel.updateProfile(fixtures.userId, { locale: 'xx-nonexistent' }),
      /ERR_INVALID_LOCALE/
    )

    const reloaded = await usersModel.getProfile(fixtures.userId)
    assert.equal(reloaded?.locale, 'fr')
  })

  test('leaves other prefs/meta fields untouched when only the locale changes', async () => {
    await usersModel.updateProfile(fixtures.userId, { timezone: 'America/New_York', cvd: 'none' })

    const updated = await usersModel.updateProfile(fixtures.userId, { locale: 'fr' })

    assert.equal(updated?.locale, 'fr')
    assert.equal(updated?.timezone, 'America/New_York')
  })
})
