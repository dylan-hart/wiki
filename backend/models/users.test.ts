import { after, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import { users } from './users.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import {
  authentication as authenticationTable,
  userKeys,
  users as usersTable
} from '../db/schema.ts'

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
