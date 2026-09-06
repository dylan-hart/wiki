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
 *
 * The `hasTestDatabase()` guard below is what a per-describe `{ skip }` cannot do for a FILE-level
 * hook: `describe(..., { skip })` skips the describe's own hooks and tests, but a root `before()`
 * runs regardless, so without this an unset `DATABASE_URL` would report every describe skipped AND
 * still throw out of the hook. Same shape as `models/contentSync.test.ts`'s own file-level fixture.
 */
let fixtures: TestFixtures

before(async () => {
  if (!hasTestDatabase()) {
    return
  }
  fixtures = await setupTestDb()
})

after(async () => {
  if (!hasTestDatabase()) {
    return
  }
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

  /**
   * Feature #2608. The provider modules read the halves off their claims; this is the other half of
   * that story — what `findOrCreateProviderUser()` does with them, which is the ONLY place in the
   * provider path that writes a name. Both rules under test come from the parent's scope: populate
   * on creation, and fill any field still empty at sign-in without touching one that is not.
   */
  describe('separated name halves from the provider profile', () => {
    async function readNames(id: string) {
      const [row] = await fixtures.db
        .select({
          name: usersTable.name,
          firstName: usersTable.firstName,
          lastName: usersTable.lastName,
          nameLocallyEdited: usersTable.nameLocallyEdited
        })
        .from(usersTable)
        .where(eq(usersTable.id, id))
        .limit(1)
      return row!
    }

    test('a new account stores both halves and derives its display name from them', async () => {
      const created = await findOrCreate(baseStrategy({ id: 'halves-create-strategy' }), {
        id: 'halves-account-1',
        email: 'halves-new@example.com',
        // -> Deliberately NOT `first last`: the halves win, and the row must not come out marked
        //    locally edited for having disagreed with a display name nobody authored here.
        name: 'Dr. Alice Example',
        firstName: 'Alice',
        lastName: 'Example'
      })

      const row = await readNames(created.id)
      assert.equal(row.firstName, 'Alice')
      assert.equal(row.lastName, 'Example')
      assert.equal(row.name, 'Alice Example')
      assert.equal(row.nameLocallyEdited, false)
    })

    test('a provider issuing no halves still stores its single display name, as before', async () => {
      const created = await findOrCreate(baseStrategy({ id: 'halves-none-strategy' }), {
        id: 'halves-account-2',
        email: 'halves-nameonly@example.com',
        name: 'Just A Name'
      })

      const row = await readNames(created.id)
      assert.equal(row.name, 'Just A Name')
      assert.equal(row.firstName, '')
      assert.equal(row.lastName, '')
    })

    test('a new account from a provider issuing only a given name is a mononym, not a fabricated surname', async () => {
      const created = await findOrCreate(baseStrategy({ id: 'halves-mononym-strategy' }), {
        id: 'halves-account-3',
        email: 'halves-mononym@example.com',
        name: 'Prince',
        firstName: 'Prince'
      })

      const row = await readNames(created.id)
      assert.equal(row.firstName, 'Prince')
      assert.equal(row.lastName, '')
      assert.equal(row.name, 'Prince')
    })

    test('a later sign-in fills a half the account never had', async () => {
      const strategy = baseStrategy({ id: 'halves-fill-strategy' })
      const [created] = await fixtures.db
        .insert(usersTable)
        .values({
          email: 'halves-fill@example.com',
          name: 'Alice Example',
          firstName: 'Alice',
          lastName: '',
          isSystem: false,
          isActive: true,
          isVerified: true,
          auth: { [strategy.id]: { id: 'halves-account-4', email: 'halves-fill@example.com' } }
        })
        .returning({ id: usersTable.id })

      await findOrCreate(strategy, {
        id: 'halves-account-4',
        email: 'halves-fill@example.com',
        name: 'Alice Example',
        firstName: 'Alice',
        lastName: 'Example'
      })

      const row = await readNames(created!.id)
      assert.equal(row.lastName, 'Example')
      // -> Re-derived, because nothing has marked this row authored.
      assert.equal(row.name, 'Alice Example')
    })

    test('a later sign-in leaves a half the account already has alone, even when the provider disagrees', async () => {
      const strategy = baseStrategy({ id: 'halves-keep-strategy' })
      const [created] = await fixtures.db
        .insert(usersTable)
        .values({
          email: 'halves-keep@example.com',
          name: 'Alicia Example-Smith',
          firstName: 'Alicia',
          lastName: 'Example-Smith',
          isSystem: false,
          isActive: true,
          isVerified: true,
          auth: { [strategy.id]: { id: 'halves-account-5', email: 'halves-keep@example.com' } }
        })
        .returning({ id: usersTable.id })

      await findOrCreate(strategy, {
        id: 'halves-account-5',
        email: 'halves-keep@example.com',
        name: 'Alice Example',
        firstName: 'Alice',
        lastName: 'Example'
      })

      const row = await readNames(created!.id)
      assert.equal(row.firstName, 'Alicia')
      assert.equal(row.lastName, 'Example-Smith')
      assert.equal(row.name, 'Alicia Example-Smith')
    })

    test('a row whose display name a person authored keeps it when a half is filled in', async () => {
      const strategy = baseStrategy({ id: 'halves-authored-strategy' })
      const [created] = await fixtures.db
        .insert(usersTable)
        .values({
          email: 'halves-authored@example.com',
          name: 'The Boss',
          firstName: '',
          lastName: '',
          nameLocallyEdited: true,
          isSystem: false,
          isActive: true,
          isVerified: true,
          auth: { [strategy.id]: { id: 'halves-account-6', email: 'halves-authored@example.com' } }
        })
        .returning({ id: usersTable.id })

      await findOrCreate(strategy, {
        id: 'halves-account-6',
        email: 'halves-authored@example.com',
        name: 'Alice Example',
        firstName: 'Alice',
        lastName: 'Example'
      })

      const row = await readNames(created!.id)
      // -> The empty halves were still worth filling; the authored display name is what survives.
      assert.equal(row.firstName, 'Alice')
      assert.equal(row.lastName, 'Example')
      assert.equal(row.name, 'The Boss')
      assert.equal(row.nameLocallyEdited, true)
    })

    test('the returned user carries the freshly-filled halves and re-derived name, not the pre-login row', async () => {
      const strategy = baseStrategy({ id: 'halves-returned-strategy' })
      await fixtures.db.insert(usersTable).values({
        email: 'halves-returned@example.com',
        name: 'Alice',
        firstName: 'Alice',
        lastName: '',
        isSystem: false,
        isActive: true,
        isVerified: true,
        auth: { [strategy.id]: { id: 'halves-account-7', email: 'halves-returned@example.com' } }
      })

      const result = await findOrCreate(strategy, {
        id: 'halves-account-7',
        email: 'halves-returned@example.com',
        name: 'Alice Example',
        firstName: 'Alice',
        lastName: 'Example'
      })

      assert.equal(result.lastName, 'Example')
      assert.equal(result.name, 'Alice Example')
      // -> The strategy link written earlier in the same call must survive the row being re-read.
      assert.equal(result.auth[strategy.id].id, 'halves-account-7')
    })

    test('a profile reporting nothing new issues no name write at all', async () => {
      const strategy = baseStrategy({ id: 'halves-noop-strategy' })
      const [created] = await fixtures.db
        .insert(usersTable)
        .values({
          email: 'halves-noop@example.com',
          name: 'Untouched Name',
          firstName: '',
          lastName: '',
          isSystem: false,
          isActive: true,
          isVerified: true,
          auth: { [strategy.id]: { id: 'halves-account-8', email: 'halves-noop@example.com' } }
        })
        .returning({ id: usersTable.id })

      await findOrCreate(strategy, {
        id: 'halves-account-8',
        email: 'halves-noop@example.com',
        name: 'Untouched Name'
      })

      const row = await readNames(created!.id)
      // -> Had a write happened with no halves, `updateUser` would have re-derived `name` to ''.
      assert.equal(row.name, 'Untouched Name')
      assert.equal(row.firstName, '')
      assert.equal(row.lastName, '')
    })
  })

  /**
   * WP #2560: relinking a migrated fallback account via `trustEmailForLinking` clears the orphaned
   * local-strategy auth entry `createProviderFallbackUserConverter()` (Feature #2547's other sibling
   * Task) originally wrote for it -- but only when that entry actually carries the migration
   * marker. `localAuthId` is seeded to the DB's real local strategy id (rather than the
   * `describe`-level placeholder) so `patchStrategyAuth`'s write lands on the same key this test
   * reads back.
   */
  describe('clearing the stale local auth entry on relink', () => {
    const localStrategyId = 'local-strategy-relink-test'

    before(() => {
      WIKI.data.systemIds = { localAuthId: localStrategyId } as any
    })

    after(() => {
      WIKI.data.systemIds = { localAuthId: 'placeholder-local-auth-id' } as any
    })

    test('clears mustChangePwd and the marker when the local entry is a migrated fallback', async () => {
      const strategy = baseStrategy({ id: 'relink-strategy-marked', trustEmailForLinking: true })
      const [created] = await fixtures.db
        .insert(usersTable)
        .values({
          email: 'fallback-marked@example.com',
          name: 'Fallback Marked',
          isSystem: false,
          isActive: true,
          isVerified: true,
          auth: {
            [localStrategyId]: {
              password: 'unreachable-random-hash',
              mustChangePwd: true,
              migratedFallbackProvider: 'ldap'
            }
          }
        })
        .returning({ id: usersTable.id })

      await findOrCreate(strategy, {
        id: 'relink-provider-id-1',
        email: 'fallback-marked@example.com',
        name: 'Fallback Marked'
      })

      const [row] = await fixtures.db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, created!.id))
      const localAuth = (row!.auth as Record<string, any>)[localStrategyId]
      assert.equal(localAuth.mustChangePwd, false)
      assert.equal('migratedFallbackProvider' in localAuth, false)
      // -> The password itself is untouched -- only the flag/marker are cleared.
      assert.equal(localAuth.password, 'unreachable-random-hash')
    })

    test('leaves an unmarked local entry alone, even with mustChangePwd true (e.g. an admin-forced reset)', async () => {
      const strategy = baseStrategy({ id: 'relink-strategy-unmarked', trustEmailForLinking: true })
      const [created] = await fixtures.db
        .insert(usersTable)
        .values({
          email: 'admin-forced-reset@example.com',
          name: 'Admin Forced Reset',
          isSystem: false,
          isActive: true,
          isVerified: true,
          auth: {
            [localStrategyId]: {
              password: 'a-real-known-hash',
              mustChangePwd: true
            }
          }
        })
        .returning({ id: usersTable.id })

      await findOrCreate(strategy, {
        id: 'relink-provider-id-2',
        email: 'admin-forced-reset@example.com',
        name: 'Admin Forced Reset'
      })

      const [row] = await fixtures.db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, created!.id))
      const localAuth = (row!.auth as Record<string, any>)[localStrategyId]
      // -> Still true: an admin-forced reset must not be silently cancelled by an SSO relink.
      assert.equal(localAuth.mustChangePwd, true)
      assert.equal(localAuth.password, 'a-real-known-hash')
    })

    test('does not touch the local entry on an ordinary already-linked login', async () => {
      const strategy = baseStrategy({ id: 'relink-strategy-already-linked' })
      const [created] = await fixtures.db
        .insert(usersTable)
        .values({
          email: 'already-linked@example.com',
          name: 'Already Linked',
          isSystem: false,
          isActive: true,
          isVerified: true,
          auth: {
            [strategy.id]: { id: 'relink-provider-id-3', email: 'already-linked@example.com' },
            [localStrategyId]: {
              password: 'unreachable-random-hash',
              mustChangePwd: true,
              migratedFallbackProvider: 'ldap'
            }
          }
        })
        .returning({ id: usersTable.id })

      await findOrCreate(strategy, {
        id: 'relink-provider-id-3',
        email: 'already-linked@example.com',
        name: 'Already Linked'
      })

      const [row] = await fixtures.db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, created!.id))
      const localAuth = (row!.auth as Record<string, any>)[localStrategyId]
      // -> Not the relink moment (this strategy was already linked), so the marker/flag survive.
      assert.equal(localAuth.mustChangePwd, true)
      assert.equal(localAuth.migratedFallbackProvider, 'ldap')
    })
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
