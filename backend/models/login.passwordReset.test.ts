import { after, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import { login } from './login.ts'
import { userCredentials } from './userCredentials.ts'
import { users } from './users.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import {
  authentication as authenticationTable,
  userKeys,
  users as usersTable
} from '../db/schema.ts'
import { ensureTemporal } from '../test/temporal.ts'

/**
 * `forgotPassword()` and `resetPassword()` are also SQL orchestration -- a strategy/config lookup, a
 * user lookup, and a token round-trip through `userKeys` -- so this runs the real methods the same
 * DB-backed way `register()`'s suite above does. `mail.sendForgotPassword` and
 * `sendPasswordResetConfirmed` are stubbed for the same reason `sendVerifyEmail` is above: no real
 * SMTP transport is needed to test this orchestration.
 */
describe('login.forgotPassword / resetPassword (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let sendForgotPasswordMock: ReturnType<typeof mock.fn>
  let sendPasswordResetConfirmedMock: ReturnType<typeof mock.fn>

  const MODULE_KEY = 'local-reset-test'

  function req(): any {
    // -> `regenerate` is a no-op stub, not a full `@fastify/session` fake: these tests assert on
    //    `afterLoginChecks`'s outcome (`nextAction`, `redirect`, ...), not on session-id churn --
    //    that is `users.updateSession`'s own describe block's job (see the stub there for the real
    //    reassignment behavior). This just needs to exist so `updateSession`'s `await
    //    req.session.regenerate()` (task 2115 / WP 2105 §4) doesn't throw on a path that reaches it.
    return { session: { regenerate: async () => {} } }
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
        selfRegistration: true,
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
    await ensureTemporal()

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
  })

  beforeEach(() => {
    sendForgotPasswordMock.mock.resetCalls()
    sendPasswordResetConfirmedMock.mock.resetCalls()
  })

  describe('forgotPassword', () => {
    test('an unknown strategy id sends nothing and does not throw', async () => {
      await login.forgotPassword({
        strategyId: '00000000-0000-0000-0000-000000000000',
        email: 'nobody@example.com'
      })
      assert.equal(sendForgotPasswordMock.mock.calls.length, 0)
    })

    test('a strategy with allowForgotPassword off sends nothing', async () => {
      const strategyId = await createStrategy({ allowForgotPassword: false })
      await createLocalUser(strategyId, { email: 'off@example.com' })

      await login.forgotPassword({ strategyId, email: 'off@example.com' })

      assert.equal(sendForgotPasswordMock.mock.calls.length, 0)
    })

    test('an email matching no account sends nothing', async () => {
      const strategyId = await createStrategy()

      await login.forgotPassword({ strategyId, email: 'nosuchaccount@example.com' })

      assert.equal(sendForgotPasswordMock.mock.calls.length, 0)
    })

    test('a matching account with no password under this strategy sends nothing', async () => {
      const strategyId = await createStrategy()
      const otherStrategyId = await createStrategy()
      await createLocalUser(otherStrategyId, { email: 'elsewhere@example.com' })

      await login.forgotPassword({ strategyId, email: 'elsewhere@example.com' })

      assert.equal(sendForgotPasswordMock.mock.calls.length, 0)
    })

    test('a deactivated account sends nothing (OpenProject #2094)', async () => {
      const strategyId = await createStrategy()
      const userId = await createLocalUser(strategyId, { email: 'deactivated@example.com' })
      await fixtures.db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, userId))

      await login.forgotPassword({ strategyId, email: 'deactivated@example.com' })

      assert.equal(sendForgotPasswordMock.mock.calls.length, 0)
    })

    test('an account with password login restricted sends nothing (OpenProject #2094)', async () => {
      const strategyId = await createStrategy()
      const userId = await createLocalUser(strategyId, { email: 'restricted@example.com' })
      const [row] = await fixtures.db.select().from(usersTable).where(eq(usersTable.id, userId))
      const auth = row!.auth as Record<string, any>
      auth[strategyId].restrictLogin = true
      await fixtures.db.update(usersTable).set({ auth }).where(eq(usersTable.id, userId))

      await login.forgotPassword({ strategyId, email: 'restricted@example.com' })

      assert.equal(sendForgotPasswordMock.mock.calls.length, 0)
    })

    test('a strategy that allows resets and a matching account: generates a resetPwd token and emails it', async () => {
      const strategyId = await createStrategy({ allowForgotPassword: true })
      const userId = await createLocalUser(strategyId, {
        email: 'wants-reset@example.com',
        name: 'Wants Reset'
      })

      await login.forgotPassword({ strategyId, email: 'Wants-Reset@Example.com' })

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
        login.resetPassword(
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
        login.resetPassword(
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
      const token = await userCredentials.generateToken({
        kind: 'resetPwd',
        userId,
        meta: { strategyId }
      })

      await assert.rejects(
        login.resetPassword(
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
      const token = await userCredentials.generateToken({
        kind: 'resetPwd',
        userId,
        meta: { strategyId }
      })
      const request = req()

      const result = await login.resetPassword(
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

    test('afterLoginChecks refuses a deactivated account, even with a still-valid reset token (OpenProject #2094)', async () => {
      const strategyId = await createStrategy()
      registerLiveStrategy(strategyId)
      const userId = await createLocalUser(strategyId, { email: 'inactive-reset@example.com' })
      // -> Minted directly rather than via `forgotPassword()`, which now refuses to mint one for a
      //    deactivated account at all: this proves `afterLoginChecks()` itself enforces the check,
      //    for a token that existed before deactivation (e.g. one purged too late, or by a path other
      //    than the admin API's `clearKeysFromUser()` call).
      const token = await userCredentials.generateToken({
        kind: 'resetPwd',
        userId,
        meta: { strategyId }
      })
      await fixtures.db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, userId))

      await assert.rejects(
        login.resetPassword(
          { siteId: fixtures.siteId, strategyId, token, newPassword: 'brandnewpwd1' },
          req()
        ),
        /ERR_INACTIVE_USER/
      )
    })

    test('afterLoginChecks refuses an unverified account, even with a still-valid reset token (OpenProject #2094)', async () => {
      const strategyId = await createStrategy()
      registerLiveStrategy(strategyId)
      const userId = await createLocalUser(strategyId, { email: 'unverified-reset@example.com' })
      const token = await userCredentials.generateToken({
        kind: 'resetPwd',
        userId,
        meta: { strategyId }
      })
      await fixtures.db
        .update(usersTable)
        .set({ isVerified: false })
        .where(eq(usersTable.id, userId))

      await assert.rejects(
        login.resetPassword(
          { siteId: fixtures.siteId, strategyId, token, newPassword: 'brandnewpwd1' },
          req()
        ),
        /ERR_USER_NOT_VERIFIED/
      )
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

      const token = await userCredentials.generateToken({
        kind: 'resetPwd',
        userId,
        meta: { strategyId }
      })
      const request = req()

      const result = await login.resetPassword(
        { siteId: fixtures.siteId, strategyId, token, newPassword: 'brandnewpwd1' },
        request
      )

      assert.equal(result.nextAction, 'provideTfa')
      assert.ok(result.continuationToken)
      assert.equal(result.authenticated, undefined)
      assert.equal(request.session.authenticated, undefined)
    })
  })

  /**
   * `clearKeysFromUser()` is what `api/users/admin.ts`'s deactivation path (`patch.isActive === false`)
   * calls alongside `sessions.clearSessionsFromUser()` (OpenProject #2094): purging a user's
   * outstanding `userKeys` rows is what stops a `resetPwd` token minted before deactivation from
   * still being redeemable afterwards.
   */
  describe('clearKeysFromUser', () => {
    test('deactivating a user with an outstanding resetPwd key leaves no usable key behind', async () => {
      const strategyId = await createStrategy()
      const userId = await createLocalUser(strategyId, { email: 'purge-keys@example.com' })
      const token = await userCredentials.generateToken({
        kind: 'resetPwd',
        userId,
        meta: { strategyId }
      })

      const [before] = await fixtures.db.select().from(userKeys).where(eq(userKeys.token, token))
      assert.ok(before, 'the token should exist before deactivation')

      await userCredentials.clearKeysFromUser(userId)

      const [after] = await fixtures.db.select().from(userKeys).where(eq(userKeys.token, token))
      assert.equal(after, undefined)

      // -> Redeeming it now fails on the token itself, not merely on the account state
      await assert.rejects(
        login.resetPassword(
          { siteId: fixtures.siteId, strategyId, token, newPassword: 'brandnewpwd1' },
          req()
        ),
        /ERR_INVALID_VALIDATION_TOKEN/
      )
    })

    test('a key belonging to a different user is left alone', async () => {
      const strategyId = await createStrategy()
      const targetUserId = await createLocalUser(strategyId, { email: 'purge-target@example.com' })
      const otherUserId = await createLocalUser(strategyId, { email: 'purge-other@example.com' })
      const otherToken = await userCredentials.generateToken({
        kind: 'resetPwd',
        userId: otherUserId,
        meta: { strategyId }
      })

      await userCredentials.clearKeysFromUser(targetUserId)

      const [row] = await fixtures.db.select().from(userKeys).where(eq(userKeys.token, otherToken))
      assert.ok(row)
    })
  })
})
