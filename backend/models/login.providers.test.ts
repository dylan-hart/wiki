import { after, before, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { login } from './login.ts'
import { userCredentials } from './userCredentials.ts'
import { users } from './users.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { userKeys, users as usersTable } from '../db/schema.ts'
import { ensureTemporal } from '../test/temporal.ts'

/**
 * One schema for the whole file rather than one per describe (TEST-F14): every `setupTestDb()` call
 * is a `CREATE SCHEMA`, the full migration set and a seed, and each describe below wants the same
 * fixture. Anything a describe needs on top of that stays in its own `before()`.
 */
let fixtures: TestFixtures

before(async () => {
  fixtures = await setupTestDb()
})

after(async () => {
  await teardownTestDb()
})

/**
 * `findOrCreateProviderUser()` (private, exercised directly rather than through `loginWithProvider()`
 * so these don't also need a live `WIKI.auth.strategies` entry and a session-bearing `req` just to
 * reach `afterLoginChecks()`) is SQL orchestration in the same sense `register()`'s suite above is: a
 * user lookup, an identity check against what is already stored, and a write. `strategy` is handed in
 * directly as a plain object matching `AuthStrategy` rather than round-tripped through
 * `authenticationTable` -- nothing under test reads the strategy back from the database.
 */
describe('login.findOrCreateProviderUser (DB-backed)', { skip: !hasTestDatabase() }, () => {
  function baseStrategy(overrides: Partial<any> = {}): any {
    return {
      id: 'provider-strategy-1',
      module: 'test-oidc',
      displayName: 'Test Provider',
      isEnabled: true,
      autoProvision: true,
      allowedEmailRegex: '',
      autoEnrollGroups: [],
      trustEmailForLinking: false,
      config: {},
      ...overrides
    }
  }

  function findOrCreate(strategy: any, profile: any): Promise<any> {
    return (login as any).findOrCreateProviderUser(strategy, profile)
  }

  before(async () => {
    WIKI.data.systemIds = { localAuthId: 'placeholder-local-auth-id' } as any
  })

  test('refuses a profile whose address belongs to a system account', async () => {
    await fixtures.db.insert(usersTable).values({
      email: 'guest-provider@example.com',
      name: 'Guest',
      isSystem: true,
      isActive: true,
      isVerified: true,
      auth: {}
    })

    await assert.rejects(
      findOrCreate(baseStrategy(), {
        id: 'provider-account-1',
        email: 'guest-provider@example.com',
        name: 'Anyone'
      }),
      /ERR_LOGIN_FAILED/
    )
  })

  test('refuses an existing account with no stored link for this strategy when trustEmailForLinking is off', async () => {
    await fixtures.db.insert(usersTable).values({
      email: 'unlinked@example.com',
      name: 'Unlinked User',
      isSystem: false,
      isActive: true,
      isVerified: true,
      auth: {}
    })

    await assert.rejects(
      findOrCreate(baseStrategy({ trustEmailForLinking: false }), {
        id: 'provider-account-2',
        email: 'unlinked@example.com',
        name: 'Unlinked User'
      }),
      /ERR_ACCOUNT_NOT_LINKED/
    )
  })

  test('trustEmailForLinking on: links an existing, previously-unlinked account instead of refusing it', async () => {
    const [created] = await fixtures.db
      .insert(usersTable)
      .values({
        email: 'trusted@example.com',
        name: 'Trusted User',
        isSystem: false,
        isActive: true,
        isVerified: true,
        auth: {}
      })
      .returning({ id: usersTable.id })

    const strategy = baseStrategy({ id: 'trusting-strategy', trustEmailForLinking: true })
    const result = await findOrCreate(strategy, {
      id: 'provider-account-3',
      email: 'trusted@example.com',
      name: 'Trusted User'
    })

    assert.equal(result.id, created!.id)
    assert.equal(result.auth[strategy.id].id, 'provider-account-3')
  })

  test('refuses a profile id that does not match the id stored for this strategy', async () => {
    const strategy = baseStrategy({ id: 'mismatch-strategy' })
    await fixtures.db.insert(usersTable).values({
      email: 'linked@example.com',
      name: 'Linked User',
      isSystem: false,
      isActive: true,
      isVerified: true,
      auth: {
        [strategy.id]: { id: 'the-real-provider-id', email: 'linked@example.com' }
      }
    })

    await assert.rejects(
      findOrCreate(strategy, {
        id: 'an-attackers-provider-id',
        email: 'linked@example.com',
        name: 'Linked User'
      }),
      /ERR_ACCOUNT_NOT_LINKED/
    )
  })

  test('accepts a profile id matching the stored link, and re-writes the link', async () => {
    const strategy = baseStrategy({ id: 'matching-strategy' })
    const [created] = await fixtures.db
      .insert(usersTable)
      .values({
        email: 'matched@example.com',
        name: 'Matched User',
        isSystem: false,
        isActive: true,
        isVerified: true,
        auth: {
          [strategy.id]: { id: 'stable-provider-id', email: 'matched@example.com' }
        }
      })
      .returning({ id: usersTable.id })

    const result = await findOrCreate(strategy, {
      id: 'stable-provider-id',
      email: 'matched@example.com',
      name: 'Matched User'
    })

    assert.equal(result.id, created!.id)
    assert.equal(result.auth[strategy.id].id, 'stable-provider-id')
  })

  test('applies allowedEmailRegex on an existing, already-linked account too, not only on creation', async () => {
    const strategy = baseStrategy({
      id: 'regex-strategy',
      allowedEmailRegex: '^[^@]+@allowed\\.example$'
    })
    await fixtures.db.insert(usersTable).values({
      email: 'linked-outside-pattern@example.com',
      name: 'Linked Outside Pattern',
      isSystem: false,
      isActive: true,
      isVerified: true,
      auth: {
        [strategy.id]: { id: 'still-a-valid-link', email: 'linked-outside-pattern@example.com' }
      }
    })

    await assert.rejects(
      findOrCreate(strategy, {
        id: 'still-a-valid-link',
        email: 'linked-outside-pattern@example.com',
        name: 'Linked Outside Pattern'
      }),
      /ERR_EMAIL_NOT_ALLOWED/
    )
  })

  test('still refuses a brand-new address when the strategy does not accept registration', async () => {
    await assert.rejects(
      findOrCreate(baseStrategy({ id: 'closed-strategy', autoProvision: false }), {
        id: 'provider-account-closed',
        email: 'never-seen-before@example.com',
        name: 'Nobody Yet'
      }),
      /ERR_REGISTRATION_DISABLED/
    )
  })
})

/**
 * `loginWithProvider()` used to hard-skip 2FA for every provider login (see WP 2101 /
 * `docs/decisions/provider-login-2fa.md`): a TOTP secret enrolled under the local strategy is a
 * signal the account's owner wants a second factor regardless of which door is used to sign in, so
 * `afterLoginChecks()` now falls back to the local strategy's own secret when the strategy actually
 * used to log in (the provider) has none of its own. `findOrCreateProviderUser()` is stubbed so
 * this suite can drive an already-provisioned account directly, the same way the `resetPassword`
 * suite above builds its account with `createUser()` and mutates its `auth` blob straight in the
 * database -- provider registration/email-matching is `findOrCreateProviderUser()`'s own concern,
 * not this one's.
 */
describe('login.loginWithProvider (DB-backed)', { skip: !hasTestDatabase() }, () => {
  const localStrategyId = 'local-provider-test'
  const providerStrategyId = 'oauth-provider-test'

  function req(): any {
    // -> `regenerate` is a no-op stub, not a full `@fastify/session` fake: these tests assert on
    //    login outcomes, not on session-id churn -- that is `users.updateSession`'s own describe
    //    block's job (see the stub there for the real reassignment behavior). This just needs to
    //    exist so `updateSession`'s `await req.session.regenerate()` (task 2115 / WP 2105 §4)
    //    doesn't throw on a path that reaches it.
    return { session: { regenerate: async () => {} } }
  }

  function registerLiveStrategies(): void {
    ;(WIKI.auth.strategies as any)[localStrategyId] = { config: {} }
    ;(WIKI.auth.strategies as any)[providerStrategyId] = { config: {} }
  }

  async function createLocalUser(email: string, name: string): Promise<string> {
    WIKI.data.systemIds = { localAuthId: localStrategyId } as any
    return users.createUser({ name, email, password: 'originalpwd1', isVerified: true })
  }

  async function enableLocalTfa(userId: string): Promise<void> {
    const [row] = await fixtures.db.select().from(usersTable).where(eq(usersTable.id, userId))
    const auth = row!.auth as Record<string, any>
    auth[localStrategyId].tfaIsActive = true
    auth[localStrategyId].tfaSecret = 'JBSWY3DPEHPK3PXP'
    await fixtures.db.update(usersTable).set({ auth }).where(eq(usersTable.id, userId))
  }

  before(async () => {
    // -> `generateToken()`/`validateToken()` call `Now.instant()`, `.add()`, `Instant.compare()` and
    //    `Date.prototype.toTemporalInstant()` between them.
    await ensureTemporal()
  })

  after(() => {
    mock.restoreAll()
  })

  test('a TOTP secret enrolled under the local strategy still gates a login through a provider strategy', async (t) => {
    registerLiveStrategies()
    const userId = await createLocalUser('provider-2fa@example.com', 'Provider Target')
    await enableLocalTfa(userId)
    const user = await users.getById(userId)
    t.mock.method(login, 'findOrCreateProviderUser' as any, async () => user)

    const result = await login.loginWithProvider(
      {
        siteId: fixtures.siteId,
        strategy: { id: providerStrategyId } as any,
        profile: { id: 'ext-1', email: 'provider-2fa@example.com', name: 'Provider Target' },
        ip: '127.0.0.1'
      },
      req()
    )

    assert.equal(result.nextAction, 'provideTfa')
    assert.ok(result.continuationToken)
    assert.equal(result.authenticated, undefined)

    // -> The continuation verifies against the local strategy's own secret, not the provider's --
    //    but still remembers the provider as the strategy actually logging in, for hooks/audit.
    const [tokenRow] = await fixtures.db
      .select()
      .from(userKeys)
      .where(eq(userKeys.token, result.continuationToken!))
    assert.deepEqual(tokenRow!.meta, {
      strategyId: providerStrategyId,
      tfaStrategyId: localStrategyId
    })
  })

  test('an account with no locally-enrolled 2FA still logs straight in through a provider', async (t) => {
    registerLiveStrategies()
    const userId = await createLocalUser('provider-no-2fa@example.com', 'No 2FA')
    const user = await users.getById(userId)
    t.mock.method(login, 'findOrCreateProviderUser' as any, async () => user)
    const request = req()

    const result = await login.loginWithProvider(
      {
        siteId: fixtures.siteId,
        strategy: { id: providerStrategyId } as any,
        profile: { id: 'ext-2', email: 'provider-no-2fa@example.com', name: 'No 2FA' },
        ip: '127.0.0.1'
      },
      request
    )

    assert.equal(result.authenticated, true)
    assert.equal(result.nextAction, 'redirect')
    assert.equal(request.session.authenticated, true)
  })

  test('a correct code from loginTFA completes the provider login the local secret stopped', async (t) => {
    registerLiveStrategies()
    const userId = await createLocalUser('provider-2fa-complete@example.com', 'Completes Login')
    await enableLocalTfa(userId)
    const user = await users.getById(userId)
    t.mock.method(login, 'findOrCreateProviderUser' as any, async () => user)
    const verifyTfaCode = t.mock.method(userCredentials, 'verifyTfaCode', () => true)
    const request = req()

    const stopped = await login.loginWithProvider(
      {
        siteId: fixtures.siteId,
        strategy: { id: providerStrategyId } as any,
        profile: {
          id: 'ext-3',
          email: 'provider-2fa-complete@example.com',
          name: 'Completes Login'
        },
        ip: '127.0.0.1'
      },
      request
    )

    const result = await login.loginTFA(
      {
        strategyId: providerStrategyId,
        siteId: fixtures.siteId,
        securityCode: '123456',
        continuationToken: stopped.continuationToken!
      },
      request
    )

    // -> Verified against the local strategy's secret, even though the login itself is the
    //    provider's. Compared field-by-field rather than with the `user` object above: that
    //    reference gets `.groups` mutated onto it by `afterLoginChecks()`'s own run inside
    //    `loginWithProvider()`, which a freshly re-fetched row from `loginTFA()`'s own
    //    `validateToken()` call never carries.
    const verifyArgs = verifyTfaCode.mock.calls[0].arguments as [any, string, string]
    assert.equal(verifyArgs[0].id, userId)
    assert.equal(verifyArgs[1], localStrategyId)
    assert.equal(verifyArgs[2], '123456')
    assert.equal(result.authenticated, true)
    assert.equal(result.nextAction, 'redirect')
    assert.equal(request.session.authenticated, true)
  })
})
