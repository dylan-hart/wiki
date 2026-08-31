import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
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
  groups as groupsTable,
  pageEditSubmissions as pageEditSubmissionsTable,
  pages as pagesTable,
  sessions as sessionsTable,
  userAvatars,
  userAvatars as userAvatarsTable,
  userGroups as userGroupsTable,
  userKeys,
  users as usersTable
} from '../db/schema.ts'
import type { RecoveryCodeEntry } from './users.ts'
import { ProvisionableLoginError } from './authentication.ts'
import { ensureTemporal } from '../test/temporal.ts'

/**
 * `updateSession` is the one place a login turns a user row into session state — permissions
 * flattened across every group the user belongs to, and the group ids kept alongside them since
 * navigation is filtered per group. It touches neither `WIKI` nor the database, so this is a pure
 * unit test: no fixture from `test/db.ts` needed.
 *
 * Task 2115 / WP 2105 §4: `updateSession` also has to regenerate the session id before writing the
 * authenticated state, closing session fixation. `makeReq()`'s stub session mimics the one load-
 * bearing thing the real `@fastify/session#regenerate()` does that matters here — reassigning
 * `req.session` to a brand-new object with a fresh id (`node_modules/@fastify/session/lib/
 * session.js`'s own `regenerate()` does `this[requestKey].session = session` inside its store
 * callback) — so a test can tell whether `updateSession` awaited it before proceeding to set fields
 * on what is, post-await, a different object than the one it started with.
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

/**
 * Stand-in for `@fastify/session`'s `Session#regenerate()` (`lib/session.js`): records that it was
 * called, then swaps `req.session` for a fresh object carrying only a new `id` — same shape the real
 * store does by replacing `this[requestKey].session` with a brand-new `Session` instance whose id
 * differs from the one it started with.
 */
function makeReq(): any {
  const req: any = { session: { id: 'pre-login-session-id' } }
  req.session.regenerate = mock.fn(async () => {
    // -> A fresh object, not a mutation of the old one — matches the real plugin reassigning
    //    `req.session` wholesale, and is what lets a test tell the two apart by reference/id.
    req.session = { id: 'post-login-session-id', regenerate: req.session.regenerate }
  })
  return req
}

describe('users.updateSession', () => {
  test('regenerates the session id before writing any authenticated state', async () => {
    const user = makeUser()
    const req = makeReq()
    const preLoginSession = req.session
    const regenerate = preLoginSession.regenerate

    await users.updateSession(user, req)

    assert.equal(regenerate.mock.callCount(), 1)
    assert.notEqual(req.session, preLoginSession, 'expected a new session object post-login')
    assert.notEqual(
      req.session.id,
      preLoginSession.id,
      'expected the post-login session id to differ from the pre-login one'
    )
    // -> Landed on the regenerated session, not stranded on the discarded pre-login one
    assert.equal(req.session.authenticated, true)
    assert.equal(preLoginSession.authenticated, undefined)
  })

  test('marks the session authenticated and copies the core user fields', async () => {
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

    await users.updateSession(user, req)

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

  test('flattens permissions across every group the user belongs to', async () => {
    const user = makeUser({
      groups: [
        { id: 'group-a', permissions: ['read:pages', 'write:comments'] },
        { id: 'group-b', permissions: ['manage:users'] }
      ]
    })
    const req = makeReq()

    await users.updateSession(user, req)

    assert.deepEqual(
      new Set(req.session.permissions),
      new Set(['read:pages', 'write:comments', 'manage:users'])
    )
    assert.equal(req.session.permissions.length, 3)
  })

  test('deduplicates a permission granted by more than one group', async () => {
    const user = makeUser({
      groups: [
        { id: 'group-a', permissions: ['read:pages', 'manage:users'] },
        { id: 'group-b', permissions: ['manage:users', 'access:admin'] }
      ]
    })
    const req = makeReq()

    await users.updateSession(user, req)

    assert.deepEqual(
      new Set(req.session.permissions),
      new Set(['read:pages', 'manage:users', 'access:admin'])
    )
    assert.equal(req.session.permissions.length, 3)
  })

  test('carries group ids alongside their permissions, in membership order', async () => {
    const user = makeUser({
      groups: [
        { id: 'group-a', permissions: ['read:pages'] },
        { id: 'group-b', permissions: [] }
      ]
    })
    const req = makeReq()

    await users.updateSession(user, req)

    assert.deepEqual(req.session.groups, ['group-a', 'group-b'])
  })

  test('a user in no groups gets an authenticated session with nothing granted', async () => {
    const user = makeUser({ groups: [] })
    const req = makeReq()

    await users.updateSession(user, req)

    assert.equal(req.session.authenticated, true)
    assert.deepEqual(req.session.permissions, [])
    assert.deepEqual(req.session.groups, [])
  })
})

/**
 * `register()` is SQL orchestration -- a strategy lookup, an existence check, then coordinating the
 * `users`, `userGroups` and `userKeys` tables -- so this runs the real method against a migrated,
 * per-run-fresh database (see `test/db.ts`), the same DB-backed pattern `models/pages.test.ts` uses.
 * `mail.sendVerifyEmail` and `mail.sendRegistrationAttemptNotice` are stubbed rather than pulling in a
 * real SMTP transport, matching how `api/mail.test.ts` isolates the route it covers from
 * `models/mail.test.ts`'s own coverage of that mapping.
 */
describe('users.register (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let sendVerifyEmailMock: ReturnType<typeof mock.fn>
  let sendRegistrationAttemptNoticeMock: ReturnType<typeof mock.fn>

  const MODULE_KEY = 'local-test'
  // -> A stand-in for a redirect-based module (SAML/OIDC/LDAP-delegation-style): `useForm: false`,
  //    same as every non-local, non-LDAP module's `definition.yml`. Used to prove `register()` refuses
  //    it outright regardless of its `selfRegistration` flag.
  const NON_FORM_MODULE_KEY = 'redirect-test'

  function req(): any {
    // -> `regenerate` is a no-op stub, not a full `@fastify/session` fake: these tests assert on
    //    `afterLoginChecks`'s outcome (`nextAction`, `redirect`, ...), not on session-id churn --
    //    that is `users.updateSession`'s own describe block's job (see the stub there for the real
    //    reassignment behavior). This just needs to exist so `updateSession`'s `await
    //    req.session.regenerate()` (task 2115 / WP 2105 §4) doesn't throw on a path that reaches it.
    return { session: { regenerate: async () => {} } }
  }

  async function createStrategy({
    module = MODULE_KEY,
    selfRegistration = true,
    autoProvision = false,
    allowedEmailRegex = '',
    autoEnrollGroups = [] as string[],
    emailValidation = true,
    isEnabled = true,
    attachToSite = true
  } = {}): Promise<string> {
    const [row] = await fixtures.db
      .insert(authenticationTable)
      .values({
        module,
        isEnabled,
        displayName: 'Test Local',
        selfRegistration,
        autoProvision,
        allowedEmailRegex,
        autoEnrollGroups,
        config: { emailValidation }
      })
      .returning({ id: authenticationTable.id })
    const strategyId = row!.id
    // -> `register()` now also checks the strategy is attached to the site the request came in on
    //    (`site.config.authStrategies`) -- `getSiteById()` reads the in-memory `WIKI.sites` cache, not
    //    the database, so the fixture site installed by `setupTestDb()` is what needs updating here.
    if (attachToSite) {
      const site = (WIKI.sites as any)[fixtures.siteId]
      site.config.authStrategies = [
        ...(site.config.authStrategies ?? []),
        { id: strategyId, order: 0, isVisible: true }
      ]
    }
    return strategyId
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

  /**
   * `register()` reads the site's attached-strategies list off `WIKI.sites[siteId].config`, the same
   * in-memory cache `getSiteById()` reads without `forceReload` -- `setupTestDb()` seeds that cache
   * once with no `authStrategies` key, so a strategy created by `createStrategy()` starts out
   * unattached to `fixtures.siteId` and every test that expects a strategy to actually work has to
   * attach it here first.
   */
  function attachStrategyToSite(strategyId: string): void {
    ;(WIKI.sites[fixtures.siteId].config as Record<string, any>).authStrategies = [
      { id: strategyId, order: 0, isVisible: true }
    ]
  }

  before(async () => {
    // -> `generateToken()`/`validateToken()` call `Now.instant()`, `.add()`, `Instant.compare()` and
    //    `Date.prototype.toTemporalInstant()` between them.
    await ensureTemporal()

    fixtures = await setupTestDb()
    const { mail } = await import('./mail.ts')
    sendVerifyEmailMock = mock.method(mail, 'sendVerifyEmail', async () => {})
    sendRegistrationAttemptNoticeMock = mock.method(
      mail,
      'sendRegistrationAttemptNotice',
      async () => {}
    )

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
      },
      {
        key: NON_FORM_MODULE_KEY,
        title: 'Test Redirect',
        description: '',
        isAvailable: true,
        useForm: false,
        usernameType: 'email',
        props: {}
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
  })

  beforeEach(() => {
    sendVerifyEmailMock.mock.resetCalls()
    sendRegistrationAttemptNoticeMock.mock.resetCalls()
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
    const strategyId = await createStrategy({ selfRegistration: false })

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

  test('refuses a strategy whose module is not form-based, even with selfRegistration set', async () => {
    const strategyId = await createStrategy({ module: NON_FORM_MODULE_KEY, selfRegistration: true })

    await assert.rejects(
      users.register(
        {
          siteId: fixtures.siteId,
          strategyId,
          name: 'Ada Lovelace',
          email: 'ada.redirect@example.com',
          password: 'longenough1'
        },
        req()
      ),
      /ERR_INVALID_STRATEGY/
    )
  })

  test('refuses a strategy not attached to the target site', async () => {
    const strategyId = await createStrategy({ attachToSite: false })

    await assert.rejects(
      users.register(
        {
          siteId: fixtures.siteId,
          strategyId,
          name: 'Ada Lovelace',
          email: 'ada.unattached@example.com',
          password: 'longenough1'
        },
        req()
      ),
      /ERR_INVALID_STRATEGY/
    )
  })

  test('autoProvision alone does not permit self-registration', async () => {
    const strategyId = await createStrategy({ selfRegistration: false, autoProvision: true })

    await assert.rejects(
      users.register(
        {
          siteId: fixtures.siteId,
          strategyId,
          name: 'Ada Lovelace',
          email: 'ada.autoprovision-only@example.com',
          password: 'longenough1'
        },
        req()
      ),
      /ERR_REGISTRATION_DISABLED/
    )
  })

  test('selfRegistration alone does not permit provider auto-provisioning', async () => {
    await assert.rejects(
      (users as any).findOrCreateProviderUser(
        {
          id: 'strategy-self-registration-only',
          module: MODULE_KEY,
          selfRegistration: true,
          autoProvision: false,
          allowedEmailRegex: '',
          autoEnrollGroups: [],
          config: {}
        },
        { id: 'ext-1', email: 'selfreg.only@example.com', name: 'Self Reg Only' }
      ),
      /ERR_REGISTRATION_DISABLED/
    )
  })

  test('refuses an address outside allowedEmailRegex', async () => {
    const strategyId = await createStrategy({ allowedEmailRegex: '^[^@]+@allowed\\.example$' })
    attachStrategyToSite(strategyId)

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

  test('a duplicate of an already-verified address, with emailValidation on, answers the same generic result a fresh registration would and notifies the real owner instead of confirming the address is taken', async () => {
    const strategyId = await createStrategy({ emailValidation: true })
    WIKI.data.systemIds = { localAuthId: strategyId } as any
    const request = req()

    const result = await users.register(
      {
        siteId: fixtures.siteId,
        strategyId,
        name: 'Attacker-Supplied Name',
        // -> setupTestDb() seeds this address already verified, owned by "Fixture User"
        email: 'fixture@example.com',
        password: 'longenough1'
      },
      request
    )

    // -> Not an oracle: indistinguishable from the fresh-registration success shape
    assert.deepEqual(result, { nextAction: 'verify' })
    assert.equal(request.session.authenticated, undefined)
    assert.equal(sendVerifyEmailMock.mock.calls.length, 0)
    assert.equal(sendRegistrationAttemptNoticeMock.mock.calls.length, 1)
    const call = sendRegistrationAttemptNoticeMock.mock.calls[0].arguments[0] as any
    assert.equal(call.to, 'fixture@example.com')

    // -> The submitted name and password were discarded -- the existing account is untouched
    const existing = await users.getByEmail('fixture@example.com')
    assert.equal(existing!.name, 'Fixture User')
  })

  test('a duplicate address on a strategy with emailValidation off still refuses as a duplicate -- no email step to route secrecy through', async () => {
    const strategyId = await createStrategy({ emailValidation: false })
    WIKI.data.systemIds = { localAuthId: strategyId } as any
    registerLiveStrategy(strategyId)

    await users.register(
      {
        siteId: fixtures.siteId,
        strategyId,
        name: 'First Registration',
        email: 'immediate-login@example.com',
        password: 'longenough1'
      },
      req()
    )

    await assert.rejects(
      users.register(
        {
          siteId: fixtures.siteId,
          strategyId,
          name: 'Second Attempt',
          email: 'immediate-login@example.com',
          password: 'longenough2'
        },
        req()
      ),
      /ERR_EMAIL_ALREADY_EXISTS/
    )
    assert.equal(sendRegistrationAttemptNoticeMock.mock.calls.length, 0)
  })

  test('emailValidation on: creates an unverified account and emails a verification link, without logging in', async () => {
    const strategyId = await createStrategy({ emailValidation: true })
    WIKI.data.systemIds = { localAuthId: strategyId } as any
    attachStrategyToSite(strategyId)
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
    attachStrategyToSite(strategyId)
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
    attachStrategyToSite(strategyId)
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
    attachStrategyToSite(strategyId)

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
 * `findOrCreateProviderUser()` (private, exercised directly rather than through `loginWithProvider()`
 * so these don't also need a live `WIKI.auth.strategies` entry and a session-bearing `req` just to
 * reach `afterLoginChecks()`) is SQL orchestration in the same sense `register()`'s suite above is: a
 * user lookup, an identity check against what is already stored, and a write. `strategy` is handed in
 * directly as a plain object matching `AuthStrategy` rather than round-tripped through
 * `authenticationTable` -- nothing under test reads the strategy back from the database.
 */
describe('users.findOrCreateProviderUser (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures

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
    return (users as any).findOrCreateProviderUser(strategy, profile)
  }

  before(async () => {
    fixtures = await setupTestDb()
    WIKI.data.systemIds = { localAuthId: 'placeholder-local-auth-id' } as any
  })

  after(async () => {
    await teardownTestDb()
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

    test('a deactivated account sends nothing (OpenProject #2094)', async () => {
      const strategyId = await createStrategy()
      const userId = await createLocalUser(strategyId, { email: 'deactivated@example.com' })
      await fixtures.db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, userId))

      await users.forgotPassword({ strategyId, email: 'deactivated@example.com' })

      assert.equal(sendForgotPasswordMock.mock.calls.length, 0)
    })

    test('an account with password login restricted sends nothing (OpenProject #2094)', async () => {
      const strategyId = await createStrategy()
      const userId = await createLocalUser(strategyId, { email: 'restricted@example.com' })
      const [row] = await fixtures.db.select().from(usersTable).where(eq(usersTable.id, userId))
      const auth = row!.auth as Record<string, any>
      auth[strategyId].restrictLogin = true
      await fixtures.db.update(usersTable).set({ auth }).where(eq(usersTable.id, userId))

      await users.forgotPassword({ strategyId, email: 'restricted@example.com' })

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

    test('afterLoginChecks refuses a deactivated account, even with a still-valid reset token (OpenProject #2094)', async () => {
      const strategyId = await createStrategy()
      registerLiveStrategy(strategyId)
      const userId = await createLocalUser(strategyId, { email: 'inactive-reset@example.com' })
      // -> Minted directly rather than via `forgotPassword()`, which now refuses to mint one for a
      //    deactivated account at all: this proves `afterLoginChecks()` itself enforces the check,
      //    for a token that existed before deactivation (e.g. one purged too late, or by a path other
      //    than the admin API's `clearKeysFromUser()` call).
      const token = await users.generateToken({ kind: 'resetPwd', userId, meta: { strategyId } })
      await fixtures.db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, userId))

      await assert.rejects(
        users.resetPassword(
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
      const token = await users.generateToken({ kind: 'resetPwd', userId, meta: { strategyId } })
      await fixtures.db
        .update(usersTable)
        .set({ isVerified: false })
        .where(eq(usersTable.id, userId))

      await assert.rejects(
        users.resetPassword(
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

  /**
   * `clearKeysFromUser()` is what `api/users.ts`'s deactivation path (`patch.isActive === false`)
   * calls alongside `sessions.clearSessionsFromUser()` (OpenProject #2094): purging a user's
   * outstanding `userKeys` rows is what stops a `resetPwd` token minted before deactivation from
   * still being redeemable afterwards.
   */
  describe('clearKeysFromUser', () => {
    test('deactivating a user with an outstanding resetPwd key leaves no usable key behind', async () => {
      const strategyId = await createStrategy()
      const userId = await createLocalUser(strategyId, { email: 'purge-keys@example.com' })
      const token = await users.generateToken({ kind: 'resetPwd', userId, meta: { strategyId } })

      const [before] = await fixtures.db.select().from(userKeys).where(eq(userKeys.token, token))
      assert.ok(before, 'the token should exist before deactivation')

      await users.clearKeysFromUser(userId)

      const [after] = await fixtures.db.select().from(userKeys).where(eq(userKeys.token, token))
      assert.equal(after, undefined)

      // -> Redeeming it now fails on the token itself, not merely on the account state
      await assert.rejects(
        users.resetPassword(
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
      const otherToken = await users.generateToken({
        kind: 'resetPwd',
        userId: otherUserId,
        meta: { strategyId }
      })

      await users.clearKeysFromUser(targetUserId)

      const [row] = await fixtures.db.select().from(userKeys).where(eq(userKeys.token, otherToken))
      assert.ok(row)
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
describe('users.loginWithProvider (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures

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
    fixtures = await setupTestDb()
  })

  after(async () => {
    mock.restoreAll()
    await teardownTestDb()
  })

  test('a TOTP secret enrolled under the local strategy still gates a login through a provider strategy', async (t) => {
    registerLiveStrategies()
    const userId = await createLocalUser('provider-2fa@example.com', 'Provider Target')
    await enableLocalTfa(userId)
    const user = await users.getById(userId)
    t.mock.method(users, 'findOrCreateProviderUser' as any, async () => user)

    const result = await users.loginWithProvider(
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
    t.mock.method(users, 'findOrCreateProviderUser' as any, async () => user)
    const request = req()

    const result = await users.loginWithProvider(
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
    t.mock.method(users, 'findOrCreateProviderUser' as any, async () => user)
    const verifyTfaCode = t.mock.method(users, 'verifyTfaCode', () => true)
    const request = req()

    const stopped = await users.loginWithProvider(
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

    const result = await users.loginTFA(
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

/**
 * OpenProject #1653: `validateToken()` reads `validUntil` back from a `timestamp` (no time zone)
 * column, so its correctness depends on how the `pg` driver reconstructs the resulting `Date` under
 * the Node process's local `TZ` -- see `docs/audit-2026-08-24/correctness-data-schema.md` §2, and the
 * epic this work package is part of (converting every such column to `timestamptz`). The defect is
 * invisible on a UTC host, which is exactly why it needs coverage that runs off UTC: this suite runs
 * under `TZ=America/New_York` for its duration.
 */
describe(
  'users.generateToken / validateToken under a non-UTC TZ (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures
    let previousTz: string | undefined

    before(async () => {
      previousTz = process.env.TZ
      process.env.TZ = 'America/New_York'
      await ensureTemporal()
      fixtures = await setupTestDb()
    })

    after(async () => {
      await teardownTestDb()
      if (previousTz === undefined) {
        delete process.env.TZ
      } else {
        process.env.TZ = previousTz
      }
    })

    test('a token issued moments ago validates as not-yet-expired, even off UTC', async () => {
      const token = await users.generateToken({ kind: 'verify', userId: fixtures.userId })

      const result = await users.validateToken({ kind: 'verify', token, skipDelete: true })

      assert.ok(
        result,
        'expected the fresh token to validate, not throw ERR_EXPIRED_VALIDATION_TOKEN'
      )
      assert.equal(result.user.id, fixtures.userId)
    })
  }
)

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
 * `passport-saml` modules, but never touching the guests group, a group the strategy's own
 * `autoEnrollGroups` still grants, a group carrying `manage:system`, or the configured root
 * administrators group — and never granting or revoking a group outside the strategy's own
 * `mappableGroups` allow-list. `WIKI.models.groups` and `users.getUserGroupIds` are stubbed rather
 * than run against a real database: what is under test here is the diffing logic, not group
 * persistence, which `models/groups.test.ts`-style DB-backed suites would be the place to cover.
 */
describe('users.syncProviderGroups', () => {
  const guestsGroupId = 'group-guests'
  const rootAdminGroupId = 'group-root-admin'

  before(() => {
    ;(globalThis as any).WIKI = {
      data: { systemIds: { guestsGroupId } },
      config: { auth: { rootAdminGroupId } },
      models: {
        flags: { authDebug: () => {} }
      }
    }
  })

  after(() => {
    delete (globalThis as any).WIKI
  })

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
    ;(globalThis as any).WIKI.models.groups = {
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

    await users.syncProviderGroups(
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

    await users.syncProviderGroups(
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

    await users.syncProviderGroups(
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

    await users.syncProviderGroups(
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

    await users.syncProviderGroups(
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

    await users.syncProviderGroups(
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

    await users.syncProviderGroups(
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

    await users.syncProviderGroups(
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

    await users.syncProviderGroups({ id: 'user-1' }, makeStrategy({ mappableGroups: [] }), [
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
    await users.syncProviderGroups({ id: 'user-1' }, makeStrategy(), ['Editors', 'Reviewers'])

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
describe('users.loginTFA', () => {
  function makeUser(overrides: Partial<any> = {}): any {
    return { id: 'user-1', email: 'ada@example.com', auth: { strat: {} }, ...overrides }
  }

  // -> `loginTFA` now consumes the account-keyed rate limit (work package 2075(b)) before verifying
  //    the submitted code — a real `WIKI.models.rateLimits.consume` stand-in that always allows,
  //    exactly like `syncProviderGroups`'s own `before`/`after` above, since nothing in this suite is
  //    testing the limiter itself (see `helpers/rateLimit.test.ts#consumeAccountAuthAttempt` for that).
  before(() => {
    ;(globalThis as any).WIKI = {
      config: { security: {} },
      models: {
        flags: { authDebug: () => {} },
        rateLimits: { consume: async () => ({ allowed: true, hits: 1, retryAfter: 0 }) }
      }
    }
  })

  after(() => {
    delete (globalThis as any).WIKI
  })

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

  test('verifies against tfaStrategyId from the token, not the login strategyId, when the token carries one', async (t) => {
    const user = makeUser({ auth: { strat: {}, local: {} } })
    t.mock.method(users, 'validateToken', async () => ({
      user,
      strategyId: 'strat',
      tfaStrategyId: 'local'
    }))
    const verifyTfaCode = t.mock.method(users, 'verifyTfaCode', () => true)
    t.mock.method(users, 'destroyToken', async () => {})
    t.mock.method(users, 'afterLoginChecks', async () => ({
      nextAction: 'redirect',
      redirect: '/'
    }))

    await users.loginTFA(
      { strategyId: 'strat', siteId: 'site-1', securityCode: '123456', continuationToken: 'tok' },
      {}
    )

    assert.deepEqual(verifyTfaCode.mock.calls[0].arguments, [user, 'local', '123456'])
  })

  test('falls back to the login strategyId when the token carries no tfaStrategyId', async (t) => {
    const user = makeUser()
    t.mock.method(users, 'validateToken', async () => ({ user, strategyId: 'strat' }))
    const verifyTfaCode = t.mock.method(users, 'verifyTfaCode', () => true)
    t.mock.method(users, 'destroyToken', async () => {})
    t.mock.method(users, 'afterLoginChecks', async () => ({
      nextAction: 'redirect',
      redirect: '/'
    }))

    await users.loginTFA(
      { strategyId: 'strat', siteId: 'site-1', securityCode: '123456', continuationToken: 'tok' },
      {}
    )

    assert.deepEqual(verifyTfaCode.mock.calls[0].arguments, [user, 'strat', '123456'])
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
    await ensureTemporal()
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

  test('two concurrent verifyAndConsumeRecoveryCode calls for the same code redeem exactly one entry', async () => {
    // -> Distinct from the sequential single-use test above, which re-reads the user between
    //    attempts and so exercises only the serialized case: this fires both attempts at once, off
    //    two separately-loaded copies of the same row, to prove the advisory lock -- not just
    //    request ordering -- is what prevents a double-spend.
    const strategyId = freshStrategyId()
    const owner = await usersModel.getById(fixtures.userId)
    const [code] = await usersModel.enableTfa(owner, strategyId)

    const [attemptA, attemptB] = await Promise.all([
      usersModel.getById(fixtures.userId),
      usersModel.getById(fixtures.userId)
    ])

    const [resultA, resultB] = await Promise.all([
      usersModel.verifyAndConsumeRecoveryCode(attemptA, strategyId, code!),
      usersModel.verifyAndConsumeRecoveryCode(attemptB, strategyId, code!)
    ])

    assert.equal([resultA, resultB].filter(Boolean).length, 1, 'exactly one attempt should redeem')

    const reloaded = (await usersModel.getById(fixtures.userId)) as any
    const entries = reloaded.auth[strategyId].recoveryCodes as RecoveryCodeEntry[]
    assert.equal(entries.filter((entry) => entry.usedAt).length, 1)
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

  test('verifyTfaCode refuses a code on a second presentation, while the next window is still accepted', async () => {
    const strategyId = freshStrategyId()
    // -> RFC 6238 Appendix B's SHA-1 test vector (same secret `helpers/totp.test.ts` uses): at
    //    Time=59s (counter 1) the code is 287082; the next 30s window (counter 2) is 359152.
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
    const owner = (await usersModel.getById(fixtures.userId)) as any
    owner.auth[strategyId] = { tfaSecret: secret, tfaIsActive: true }
    await fixtures.db
      .update(usersTable)
      .set({ auth: owner.auth })
      .where(eq(usersTable.id, fixtures.userId))

    mock.timers.enable({ apis: ['Date'], now: 59_000 })
    try {
      const firstAttempt = await usersModel.getById(fixtures.userId)
      assert.equal(await usersModel.verifyTfaCode(firstAttempt, strategyId, '287082'), true)

      // -> Same code, presented again inside the same ±30s drift window: refused, since its counter
      //    was already recorded as `tfaLastCounter` by the accepted attempt above.
      const replayAttempt = await usersModel.getById(fixtures.userId)
      assert.equal(await usersModel.verifyTfaCode(replayAttempt, strategyId, '287082'), false)

      // -> A different code from the next window is not a replay of the same counter, so it is still
      //    accepted -- single-use blocks the matched counter, not the whole secret.
      const nextWindowAttempt = await usersModel.getById(fixtures.userId)
      assert.equal(await usersModel.verifyTfaCode(nextWindowAttempt, strategyId, '359152'), true)
    } finally {
      mock.timers.reset()
    }
  })

  test('verifyTfaCode persists the matched counter so it survives a reload, not just in-process', async () => {
    const strategyId = freshStrategyId()
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
    const owner = (await usersModel.getById(fixtures.userId)) as any
    owner.auth[strategyId] = { tfaSecret: secret, tfaIsActive: true }
    await fixtures.db
      .update(usersTable)
      .set({ auth: owner.auth })
      .where(eq(usersTable.id, fixtures.userId))

    mock.timers.enable({ apis: ['Date'], now: 59_000 })
    try {
      const attempt = await usersModel.getById(fixtures.userId)
      assert.equal(await usersModel.verifyTfaCode(attempt, strategyId, '287082'), true)

      const reloaded = (await usersModel.getById(fixtures.userId)) as any
      assert.equal(reloaded.auth[strategyId].tfaLastCounter, 1)
    } finally {
      mock.timers.reset()
    }
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

  describe('verifyTfaCode single-use (RFC 6238 §5.2)', () => {
    // -> RFC 6238 Appendix B's SHA-1 test vector, the same secret/code pair `helpers/totp.test.ts`
    //    verifies against -- reused here rather than re-derived, since what is under test is the
    //    persistence/replay-refusal wrapper around `verifyTotpCode`, not the HOTP algorithm itself.
    const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
    const codeForCounter1 = '287082' // Time=59_000ms -> counter = floor(59 / 30) = 1

    test('accepts a code once, then refuses the identical code presented again', async () => {
      const strategyId = freshStrategyId()
      const owner = (await usersModel.getById(fixtures.userId)) as any
      await fixtures.db
        .update(usersTable)
        .set({ auth: { ...owner.auth, [strategyId]: { tfaSecret: rfcSecret, tfaIsActive: true } } })
        .where(eq(usersTable.id, fixtures.userId))

      mock.timers.enable({ apis: ['Date'], now: 59_000 })
      try {
        const firstAttempt = await usersModel.getById(fixtures.userId)
        assert.equal(
          await usersModel.verifyTfaCode(firstAttempt, strategyId, codeForCounter1),
          true
        )

        // -> Same code, same still-valid drift window, freshly-reloaded user: only the persisted
        //    `tfaLastCounter` this first call wrote stands between this and a second acceptance.
        const secondAttempt = await usersModel.getById(fixtures.userId)
        assert.equal(
          await usersModel.verifyTfaCode(secondAttempt, strategyId, codeForCounter1),
          false
        )
      } finally {
        mock.timers.reset()
      }
    })

    test('persists the matched counter as tfaLastCounter', async () => {
      const strategyId = freshStrategyId()
      const owner = (await usersModel.getById(fixtures.userId)) as any
      await fixtures.db
        .update(usersTable)
        .set({ auth: { ...owner.auth, [strategyId]: { tfaSecret: rfcSecret, tfaIsActive: true } } })
        .where(eq(usersTable.id, fixtures.userId))

      mock.timers.enable({ apis: ['Date'], now: 59_000 })
      try {
        const attempt = await usersModel.getById(fixtures.userId)
        await usersModel.verifyTfaCode(attempt, strategyId, codeForCounter1)
      } finally {
        mock.timers.reset()
      }

      const reloaded = (await usersModel.getById(fixtures.userId)) as any
      assert.equal(reloaded.auth[strategyId].tfaLastCounter, 1)
    })
  })
})

/**
 * The lost-update case #2149 closes: every whole-blob `auth` write in `models/users.ts` now reads,
 * mutates and writes while holding a `user-auth:<id>` advisory lock (`helpers/advisoryLock.ts`), so
 * two of these calls racing the same user's row can no longer have the second writer's stale copy of
 * the blob clobber the first writer's change. Before this, `adminInvalidateTfa()` blanking
 * `tfaSecret`/`tfaIsActive`/`recoveryCodes` was observed being undone by a concurrent
 * `changeOwnPassword()` that had already read the (still-active) blob and later wrote its own copy of
 * it back, with the password change alone surviving -- silently restoring 2FA the admin had just
 * turned off.
 *
 * This runs both calls concurrently via a real advisory lock against Postgres (not a mock), which is
 * the only way to actually exercise the serialization rather than merely asserting the source calls
 * `withAdvisoryLock`.
 */
describe('users auth-write serialization (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let usersModel: typeof import('./users.ts').users

  before(async () => {
    fixtures = await setupTestDb()
    ;({ users: usersModel } = await import('./users.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  function freshStrategyId(): string {
    return `strategy-${Math.random().toString(36).slice(2)}`
  }

  test('an adminInvalidateTfa concurrent with a changeOwnPassword leaves 2FA blanked, not restored', async () => {
    const strategyId = freshStrategyId()
    const currentPassword = 'the-old-password'

    // -> Seed a strategy entry with both a password (changeOwnPassword's target) and active 2FA
    //    (adminInvalidateTfa's target) so the two operations' writes genuinely overlap on the same
    //    `auth[strategyId]` object rather than touching disjoint strategies.
    const seeded = (await usersModel.getById(fixtures.userId)) as any
    await fixtures.db
      .update(usersTable)
      .set({
        auth: {
          ...seeded.auth,
          [strategyId]: {
            password: await bcrypt.hash(currentPassword, 12),
            mustChangePwd: false,
            tfaIsActive: true,
            tfaSecret: 'existing-secret',
            recoveryCodes: [{ hash: 'x', usedAt: null }]
          }
        }
      })
      .where(eq(usersTable.id, fixtures.userId))

    await Promise.all([
      usersModel.adminInvalidateTfa(fixtures.userId, strategyId),
      usersModel.changeOwnPassword({
        userId: fixtures.userId,
        strategyId,
        currentPassword,
        newPassword: 'a-brand-new-password'
      })
    ])

    const reloaded = (await usersModel.getById(fixtures.userId)) as any
    const strategyAuth = reloaded.auth[strategyId]

    // -> The admin's action must have stuck, regardless of which write happened to land second.
    assert.equal(strategyAuth.tfaIsActive, false)
    assert.equal(strategyAuth.tfaSecret, '')
    assert.deepEqual(strategyAuth.recoveryCodes, [])

    // -> The password change must have stuck too -- neither write may be the one that gets lost.
    assert.equal(strategyAuth.mustChangePwd, false)
    assert.equal(await bcrypt.compare('a-brand-new-password', strategyAuth.password), true)
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
describe('users.login (form-based provider auto-provisioning)', () => {
  const strategyId = 'strategy-1'

  function makeProfile(overrides: Partial<any> = {}): any {
    return { id: 'ext-1', email: 'ada@example.com', name: 'Ada Lovelace', ...overrides }
  }

  function installWiki(getStrategyById: () => Promise<any>) {
    ;(globalThis as any).WIKI = {
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
    }
  }

  after(() => {
    delete (globalThis as any).WIKI
  })

  test('a returning provider user is not refused just because the strategy has autoProvision disabled', async (t) => {
    installWiki(async () => ({ id: strategyId, module: 'ldap', autoProvision: false, config: {} }))
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
    installWiki(async () => ({ id: strategyId, module: 'ldap', autoProvision: false, config: {} }))
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

  test('autoProvision enabled still provisions a brand-new address', async (t) => {
    installWiki(async () => ({ id: strategyId, module: 'ldap', autoProvision: true, config: {} }))
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
 * `login()`'s own defense-in-depth guard against an empty/missing password on a `useForm` strategy
 * (LDAP being the one this actually protects, since its module-level check is the other half of the
 * same fix) — the route schema requiring `password` is the first guard, this is the second, and
 * neither is allowed to depend on the other alone.
 */
describe('users.login (empty/missing password guard)', () => {
  const strategyId = 'strategy-1'

  function installWiki(authenticate: () => Promise<any>) {
    ;(globalThis as any).WIKI = {
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
    }
  }

  after(() => {
    delete (globalThis as any).WIKI
  })

  test('an empty-string password is refused as ERR_LOGIN_FAILED without ever calling the strategy', async (t) => {
    const authenticate = t.mock.fn(async () => {
      throw new Error('should not be called')
    })
    installWiki(authenticate)

    await assert.rejects(
      users.login(
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
      users.login(
        { siteId: 'site-1', strategyId, username: 'ada', ip: '127.0.0.1' },
        { session: {} }
      ),
      /ERR_LOGIN_FAILED/
    )
    assert.equal(authenticate.mock.calls.length, 0)
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
 * `createUser()` atomicity (OpenProject #1607 / #1584): the insert and its group assignment now
 * share one `WIKI.db.transaction()`, so a failure in `setUserGroups` after the insert must leave no
 * orphaned user row behind, and the ordinary path must still land both.
 */
describe('users.createUser atomicity (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures

  before(async () => {
    fixtures = await setupTestDb()
    // -> Matches `users.forgotPassword / resetPassword`'s own `createLocalUser` helper above: nothing
    //    under test here logs in, so this needs no matching `authentication` row, just a key for
    //    `createUser()` to store the password hash under.
    WIKI.data.systemIds = { localAuthId: 'atomic-create-test-strategy' } as any
  })

  after(async () => {
    await teardownTestDb()
  })

  test('rolls back the user insert when group assignment fails', async (t) => {
    t.mock.method(users, 'setUserGroups', async () => {
      throw new Error('simulated group-assignment failure')
    })

    await assert.rejects(
      users.createUser({
        name: 'Rollback Test',
        email: 'rollback-atomic@example.com',
        password: 'a-long-password',
        groups: [fixtures.groupId],
        isVerified: true
      }),
      /simulated group-assignment failure/
    )

    const rows = await fixtures.db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, 'rollback-atomic@example.com'))
    assert.equal(rows.length, 0)
  })

  test('the ordinary create path lands both the user row and its group memberships', async () => {
    const userId = await users.createUser({
      name: 'Ordinary Create',
      email: 'ordinary-atomic@example.com',
      password: 'a-long-password',
      groups: [fixtures.groupId],
      isVerified: true
    })

    const [row] = await fixtures.db.select().from(usersTable).where(eq(usersTable.id, userId))
    assert.ok(row)
    assert.equal(row!.email, 'ordinary-atomic@example.com')

    const memberships = await fixtures.db
      .select()
      .from(userGroupsTable)
      .where(eq(userGroupsTable.userId, userId))
    assert.equal(memberships.length, 1)
    assert.equal(memberships[0]!.groupId, fixtures.groupId)
  })
})

/**
 * OpenProject #1742 (part of #1730): `setUserGroups` used to run its delete-then-insert as two
 * separate statements on the default connection with no transaction. `userGroups`' primary key is
 * `(userId, groupId)`, so a group deleted in the window between reading which ids are still valid and
 * the insert actually running would fail the whole multi-row insert on an FK violation -- and because
 * the delete had already committed on its own, the user was left in *no* groups at all: no admin
 * access, no page rules, with the caller's error saying nothing about membership having been wiped.
 * `setUserGroups` now wraps both statements in one transaction, so a failed insert rolls the delete
 * back with it.
 */
describe('users.setUserGroups (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let usersModel: typeof import('./users.ts').users

  before(async () => {
    fixtures = await setupTestDb()
    ;({ users: usersModel } = await import('./users.ts'))
    // -> `setUserGroups` -> `groups.guestMembershipViolation` reads `WIKI.data.systemIds.guestsGroupId`
    //    -- a full-boot value the minimal test `WIKI` does not carry. Neither group id used below is
    //    this one, so it never actually matches; it only has to be present for the read not to throw.
    WIKI.data.systemIds = { guestsGroupId: '00000000-0000-0000-0000-000000000000' }
  })

  after(async () => {
    await teardownTestDb()
  })

  test('an FK violation on the insert half rolls back the delete, leaving prior membership intact', async () => {
    const [raceUser] = await fixtures.db
      .insert(usersTable)
      .values({
        email: 'group-race@example.com',
        name: 'Group Race User',
        isActive: true,
        isVerified: true
      })
      .returning({ id: usersTable.id })
    const [raceGroup] = await fixtures.db
      .insert(groupsTable)
      .values({ name: 'FK Race Group', permissions: [], rules: [] })
      .returning({ id: groupsTable.id })

    // -> Real prior membership -- this is what a botched transaction would leave the user stripped of
    await usersModel.setUserGroups(raceUser!.id, [fixtures.groupId])

    /*
      Sabotages the transaction from the outside, at exactly the point `setUserGroups` opens it --
      deleting the target group out from under the still-to-run insert reproduces the real race: a
      group deleted in the window between `setUserGroups` reading it as valid and the insert actually
      running. `WIKI.db.transaction` itself, and everything `setUserGroups` does inside it, run for
      real and unmocked; only the timing of the group's deletion is engineered.
    */
    const originalTransaction = WIKI.db.transaction.bind(WIKI.db)
    const transactionSpy = mock.method(WIKI.db, 'transaction', (fn: any) =>
      originalTransaction(async (tx: any) => {
        await fixtures.db.delete(groupsTable).where(eq(groupsTable.id, raceGroup!.id))
        return fn(tx)
      })
    )
    try {
      await assert.rejects(() => usersModel.setUserGroups(raceUser!.id, [raceGroup!.id]))
    } finally {
      transactionSpy.mock.restore()
    }

    const membership = await fixtures.db
      .select({ groupId: userGroupsTable.groupId })
      .from(userGroupsTable)
      .where(eq(userGroupsTable.userId, raceUser!.id))
    assert.deepEqual(
      membership.map((m) => m.groupId),
      [fixtures.groupId],
      'the prior membership survived the failed insert instead of being left empty'
    )
  })
})

/**
 * `deleteUser` is SQL orchestration over four tables in one transaction — the same
 * real-database case `reassignContent (DB-backed)` above is for, not one a query-builder mock
 * would usefully stand in for: what's under test is that the avatar and open submissions are
 * really gone afterwards, and that a refused delete really leaves sessions/keys/avatar alone.
 */
describe('users.deleteUser (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let usersModel: typeof import('./users.ts').users

  before(async () => {
    fixtures = await setupTestDb()
    ;({ users: usersModel } = await import('./users.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  async function insertUser(email: string) {
    const [row] = await fixtures.db
      .insert(usersTable)
      .values({ email, name: email, isActive: true, isVerified: true })
      .returning({ id: usersTable.id })
    return row!.id
  }

  function rawPageRow(overrides: { path: string; authorId: string }) {
    return {
      locale: 'en',
      path: overrides.path,
      hash: `delete-user-hash-${overrides.path}`,
      title: 'Delete Me',
      editor: 'markdown',
      contentType: 'markdown',
      authorId: overrides.authorId,
      creatorId: overrides.authorId,
      ownerId: overrides.authorId,
      siteId: fixtures.siteId,
      classification: fixtures.classificationId
    }
  }

  test('deleting a user with an avatar leaves no userAvatars row and getAvatar() returns nothing', async () => {
    const userId = await insertUser('avatar-owner@example.com')
    await fixtures.db
      .insert(userAvatars)
      .values({ id: userId, data: Buffer.from('fake-jpeg'), hash: 'fake-hash' })

    const deleted = await usersModel.deleteUser(userId)

    assert.equal(deleted, true)
    const [avatarRow] = await fixtures.db
      .select()
      .from(userAvatars)
      .where(eq(userAvatars.id, userId))
    assert.equal(avatarRow, undefined)
    assert.equal(await usersModel.getAvatar(userId), null)
  })

  test("a delete refused by a foreign-key conflict leaves the user's sessions and keys intact", async () => {
    const userId = await insertUser('blocked-delete@example.com')
    await fixtures.db.insert(sessionsTable).values({ id: `sess-${userId}`, userId })
    await fixtures.db.insert(userKeys).values({
      kind: 'validation',
      token: `token-${userId}`,
      validUntil: new Date(Date.now() + 60_000),
      userId
    })
    // -> No onDelete cascade or set null on pages.authorId (see reassignContent's own doc comment),
    //    so an authored page is exactly what makes deleteUser() throw a 23503 foreign-key violation.
    await fixtures.db
      .insert(pagesTable)
      .values(rawPageRow({ path: 'blocked/page', authorId: userId }))

    await assert.rejects(usersModel.deleteUser(userId))

    const [userRow] = await fixtures.db.select().from(usersTable).where(eq(usersTable.id, userId))
    assert.ok(userRow, 'the user row must still exist')
    const sessionRows = await fixtures.db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.userId, userId))
    assert.equal(sessionRows.length, 1)
    const keyRows = await fixtures.db.select().from(userKeys).where(eq(userKeys.userId, userId))
    assert.equal(keyRows.length, 1)
  })

  test('a user with an open edit submission is deletable because the transaction discards it', async () => {
    const userId = await insertUser('submitter@example.com')
    const [page] = await fixtures.db
      .insert(pagesTable)
      .values(rawPageRow({ path: 'submission/target', authorId: fixtures.userId }))
      .returning({ id: pagesTable.id })
    await fixtures.db.insert(pageEditSubmissionsTable).values({
      content: 'edited content',
      patch: '--- a\n+++ b\n',
      baseHash: 'deadbeef',
      pageId: page!.id,
      siteId: fixtures.siteId,
      authorId: userId
    })

    const deleted = await usersModel.deleteUser(userId)

    assert.equal(deleted, true)
    const submissionRows = await fixtures.db
      .select()
      .from(pageEditSubmissionsTable)
      .where(eq(pageEditSubmissionsTable.authorId, userId))
    assert.equal(submissionRows.length, 0)
  })
})

/**
 * `setUserGroups` replaces a user's membership with a delete-then-insert, now wrapped in one
 * `WIKI.db.transaction()` (see `models/users.ts`) so the pair commits or fails together. Verified by
 * handing the model's transaction callback a `tx` stand-in whose `delete` is the real, bound method
 * (so it runs for real against Postgres) and whose `insert` is forced to throw — if the two statements
 * were still unwrapped, the delete would already be committed by the time the insert failed, and the
 * user would be left with no groups at all instead of the ones they started with.
 */
describe('users.setUserGroups (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let usersModel: typeof import('./users.ts').users
  let groupAId: string
  let groupBId: string

  before(async () => {
    fixtures = await setupTestDb()
    ;({ users: usersModel } = await import('./users.ts'))
    // -> No guests group in this fixture's seed data; `setUserGroups` reads this to keep the guest
    //    account/guests group pairing intact, and a value that matches neither group under test is
    //    what makes both of them ordinary, assignable groups.
    WIKI.data.systemIds = { guestsGroupId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' } as any

    const [groupA] = await fixtures.db
      .insert(groupsTable)
      .values({ name: 'setUserGroups Group A', permissions: [], rules: [] })
      .returning({ id: groupsTable.id })
    groupAId = groupA!.id

    const [groupB] = await fixtures.db
      .insert(groupsTable)
      .values({ name: 'setUserGroups Group B', permissions: [], rules: [] })
      .returning({ id: groupsTable.id })
    groupBId = groupB!.id
  })

  after(async () => {
    await teardownTestDb()
  })

  test('leaves prior membership intact when the insert half of the swap fails', async (t) => {
    await usersModel.setUserGroups(fixtures.userId, [groupAId])
    const before = await fixtures.db
      .select({ groupId: userGroupsTable.groupId })
      .from(userGroupsTable)
      .where(eq(userGroupsTable.userId, fixtures.userId))
    assert.deepEqual(
      before.map((r) => r.groupId),
      [groupAId]
    )

    const originalTransaction = fixtures.db.transaction.bind(fixtures.db)
    t.mock.method(fixtures.db, 'transaction', (callback: (tx: unknown) => Promise<unknown>) =>
      originalTransaction((tx: any) => {
        const fakeTx = {
          delete: tx.delete.bind(tx),
          insert: () => {
            throw new Error('simulated insert failure')
          }
        }
        return callback(fakeTx)
      })
    )

    await assert.rejects(
      usersModel.setUserGroups(fixtures.userId, [groupBId]),
      /simulated insert failure/
    )

    const after = await fixtures.db
      .select({ groupId: userGroupsTable.groupId })
      .from(userGroupsTable)
      .where(eq(userGroupsTable.userId, fixtures.userId))
    assert.deepEqual(
      after.map((r) => r.groupId),
      [groupAId]
    )
  })
})
describe('users.importLocalUser (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let usersModel: typeof import('./users.ts').users

  before(async () => {
    fixtures = await setupTestDb()
    ;({ users: usersModel } = await import('./users.ts'))
    WIKI.data.systemIds = { localAuthId: 'import-local-auth-strategy-id' } as any
  })

  after(async () => {
    await teardownTestDb()
  })

  test('persists a passed isActive: false and the source createdAt, rather than the old hardcoded defaults', async () => {
    const sourceCreatedAt = new Date('2018-05-01T00:00:00.000Z')

    const result = await usersModel.importLocalUser({
      name: 'Deactivated Import',
      email: 'deactivated-import@example.com',
      passwordHash: '$2a$12$fakehashfordbbackedtest',
      isActive: false,
      isVerified: false,
      meta: { jobTitle: 'Staff Engineer', location: 'Remote' },
      prefs: { timezone: 'Europe/Berlin' },
      createdAt: sourceCreatedAt
    })

    assert.equal(result.status, 'created')
    if (result.status !== 'created') return

    const [row] = await fixtures.db.select().from(usersTable).where(eq(usersTable.id, result.id))
    assert.equal(row!.isActive, false)
    assert.equal(row!.isVerified, false)
    assert.deepEqual(row!.meta, { jobTitle: 'Staff Engineer', location: 'Remote', pronouns: '' })
    assert.equal((row!.prefs as any).timezone, 'Europe/Berlin')
    assert.equal(row!.createdAt.toISOString(), sourceCreatedAt.toISOString())
  })

  test('falls back to isActive: false and the column defaults when no source state is given', async () => {
    const result = await usersModel.importLocalUser({
      name: 'Bare Import',
      email: 'bare-import@example.com',
      passwordHash: '$2a$12$fakehashfordbbackedtest'
    })

    assert.equal(result.status, 'created')
    if (result.status !== 'created') return

    const [row] = await fixtures.db.select().from(usersTable).where(eq(usersTable.id, result.id))
    assert.equal(row!.isActive, false)
    assert.ok(row!.createdAt) // -> column's own defaultNow(), not left null
  })
})

/**
 * `applyUserUpdate()` atomicity (OpenProject #1609 / #1584): the profile patch, group replacement,
 * auth-flag write and session clear now share one `WIKI.db.transaction()` -- this is what
 * `PUT /users/:userId` calls in place of its previously separate, non-transactional sequence. A
 * failure partway through must leave every earlier write in the same call rolled back too.
 */
describe('users.applyUserUpdate atomicity (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let targetUserId: string
  const localStrategyId = 'atomic-update-test-strategy'

  before(async () => {
    fixtures = await setupTestDb()
    WIKI.data.systemIds = { localAuthId: localStrategyId } as any

    targetUserId = await users.createUser({
      name: 'Apply Update Target',
      email: 'apply-update-target@example.com',
      password: 'original-password1',
      groups: [fixtures.groupId],
      isVerified: true
    })
  })

  after(async () => {
    await teardownTestDb()
  })

  test('a failure at the auth-flags step leaves the profile patch and group membership unchanged', async (t) => {
    t.mock.method(users, 'setUserAuthFlags', async () => {
      throw new Error('simulated auth-flag failure')
    })

    await assert.rejects(
      users.applyUserUpdate(targetUserId, {
        patch: { name: 'Renamed Mid-Transaction' },
        groups: [],
        authFlags: { mustChangePwd: true }
      }),
      /simulated auth-flag failure/
    )

    const [row] = await fixtures.db.select().from(usersTable).where(eq(usersTable.id, targetUserId))
    assert.equal(row!.name, 'Apply Update Target')

    const memberships = await fixtures.db
      .select()
      .from(userGroupsTable)
      .where(eq(userGroupsTable.userId, targetUserId))
    assert.equal(memberships.length, 1)
    assert.equal(memberships[0]!.groupId, fixtures.groupId)
  })

  test('the ordinary update path applies the profile patch, group change, and auth flags together', async () => {
    await users.applyUserUpdate(targetUserId, {
      patch: { name: 'Renamed For Real' },
      groups: [],
      authFlags: { mustChangePwd: true }
    })

    const [row] = await fixtures.db.select().from(usersTable).where(eq(usersTable.id, targetUserId))
    assert.equal(row!.name, 'Renamed For Real')
    assert.equal((row!.auth as Record<string, any>)[localStrategyId].mustChangePwd, true)

    const memberships = await fixtures.db
      .select()
      .from(userGroupsTable)
      .where(eq(userGroupsTable.userId, targetUserId))
    assert.equal(memberships.length, 0)
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

/**
 * #1619/#1611: `users.prefs` gains a `locale` entry, validated against the installed locale
 * catalogue on write — the preference `models/mail.ts`'s server-side string resolver (#1623) reads
 * to address a recipient in their own language rather than always `en`.
 */
describe('users.updateProfile locale preference (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let usersModel: typeof import('./users.ts').users

  before(async () => {
    fixtures = await setupTestDb()
    ;({ users: usersModel } = await import('./users.ts'))
    await seedLocale(fixtures.db, { code: 'en' })
    await seedLocale(fixtures.db, { code: 'fr' })
  })

  after(async () => {
    await teardownTestDb()
  })

  test('persists a known locale and reads it back on the profile', async () => {
    const updated = await usersModel.updateProfile(fixtures.userId, { locale: 'fr' })
    assert.equal(updated?.locale, 'fr')

    const reloaded = await usersModel.getProfile(fixtures.userId)
    assert.equal(reloaded?.locale, 'fr')
  })

  test('clears the preference when set to an empty string', async () => {
    await usersModel.updateProfile(fixtures.userId, { locale: 'fr' })

    const cleared = await usersModel.updateProfile(fixtures.userId, { locale: '' })
    assert.equal(cleared?.locale, '')
  })

  test('rejects a locale code the instance does not have installed', async () => {
    await assert.rejects(
      () => usersModel.updateProfile(fixtures.userId, { locale: 'xx-not-installed' }),
      /ERR_INVALID_LOCALE/
    )
  })

  test('a locale-only update leaves other preferences untouched', async () => {
    await usersModel.updateProfile(fixtures.userId, { appearance: 'dark', cvd: 'protanopia' })

    const updated = await usersModel.updateProfile(fixtures.userId, { locale: 'en' })

    assert.equal(updated?.locale, 'en')
    assert.equal(updated?.appearance, 'dark')
    assert.equal(updated?.cvd, 'protanopia')
  })
})

/**
 * OpenProject #1849: `setAvatar` writes the sha1 of the exact (Sharp-normalized-or-not) bytes it
 * stores, and `getAvatarHash` reads it back without touching `data`. This round-trips the real write
 * path against a migrated database rather than re-describing its SQL.
 */
describe('users.setAvatar / getAvatarHash (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let usersModel: typeof import('./users.ts').users

  before(async () => {
    fixtures = await setupTestDb()
    ;({ users: usersModel } = await import('./users.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  test('getAvatarHash returns null for a user with no avatar', async () => {
    assert.equal(await usersModel.getAvatarHash(fixtures.userId), null)
  })

  test('setAvatar stores a hash equal to the sha1 of the bytes getAvatar later returns', async () => {
    await usersModel.setAvatar(fixtures.userId, Buffer.from('first-avatar-bytes'))

    const avatar = await usersModel.getAvatar(fixtures.userId)
    const hash = await usersModel.getAvatarHash(fixtures.userId)

    assert.ok(avatar)
    const expected = crypto.createHash('sha1').update(avatar!.data).digest('hex')
    assert.equal(hash, expected)
  })

  test('re-uploading different bytes changes the hash', async () => {
    await usersModel.setAvatar(fixtures.userId, Buffer.from('avatar-version-one'))
    const firstHash = await usersModel.getAvatarHash(fixtures.userId)

    await usersModel.setAvatar(fixtures.userId, Buffer.from('avatar-version-two-different'))
    const secondHash = await usersModel.getAvatarHash(fixtures.userId)

    assert.notEqual(firstHash, secondHash)
    const avatar = await usersModel.getAvatar(fixtures.userId)
    assert.equal(secondHash, crypto.createHash('sha1').update(avatar!.data).digest('hex'))
  })

  test('clearAvatar leaves getAvatarHash returning null again', async () => {
    await usersModel.setAvatar(fixtures.userId, Buffer.from('avatar-to-clear'))
    assert.ok(await usersModel.getAvatarHash(fixtures.userId), 'sanity: upload landed first')

    await usersModel.clearAvatar(fixtures.userId)

    assert.equal(await usersModel.getAvatarHash(fixtures.userId), null)
  })
})

/**
 * OpenProject #1849: `getAvatarHash` exists specifically so a conditional avatar request never pulls
 * the blob out of the database. A real Postgres round trip only proves the returned value is correct,
 * not that the column list sent to it actually shrank — so this spies on `WIKI.db.select` instead,
 * following the precedent set by `models/pages.test.ts`'s `getPage selection (pure unit, OpenProject
 * #1834)` describe block.
 */
describe('getAvatarHash selection (pure unit, OpenProject #1849)', () => {
  let previousWiki: typeof globalThis.WIKI

  function stubSelect(row?: Record<string, unknown>) {
    const calls: Record<string, unknown>[] = []
    const chain: any = {}
    chain.from = mock.fn(() => chain)
    chain.where = mock.fn(() => chain)
    chain.limit = mock.fn(async () => (row ? [row] : []))
    const select = mock.fn((config: Record<string, unknown>) => {
      calls.push(config)
      return chain
    })
    return { select, calls }
  }

  beforeEach(() => {
    previousWiki = globalThis.WIKI
  })

  afterEach(() => {
    globalThis.WIKI = previousWiki
  })

  test('the emitted selection asks only for hash, never data', async () => {
    const { select, calls } = stubSelect({ hash: 'deadbeef' })
    globalThis.WIKI = { db: { select } } as unknown as typeof globalThis.WIKI
    const { users: usersModel } = await import('./users.ts')

    const hash = await usersModel.getAvatarHash('user-1')

    assert.equal(hash, 'deadbeef')
    assert.equal(calls.length, 1)
    const selectedKeys = Object.keys(calls[0]!)
    assert.deepEqual(selectedKeys, ['hash'])
  })

  test('returns null rather than throwing when no row matches', async () => {
    const { select } = stubSelect(undefined)
    globalThis.WIKI = { db: { select } } as unknown as typeof globalThis.WIKI
    const { users: usersModel } = await import('./users.ts')

    assert.equal(await usersModel.getAvatarHash('missing-user'), null)
  })
})

/**
 * `userAvatars.id` carries an `onDelete: 'cascade'` foreign key to `users.id` (see `db/schema.ts`) —
 * an avatar dies with its user at the database layer, not merely through `deleteUser()` remembering
 * to clean it up. Deleting the `users` row directly, bypassing `deleteUser()` entirely, is what
 * actually exercises that the constraint (rather than app code) is what enforces it.
 */
describe('userAvatars cascades from users (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures

  before(async () => {
    fixtures = await setupTestDb()
  })

  after(async () => {
    await teardownTestDb()
  })

  test('removes the avatar when the users row is deleted directly, without calling deleteUser()', async () => {
    const [avatarOwner] = await fixtures.db
      .insert(usersTable)
      .values({
        email: 'avatar-owner@example.com',
        name: 'Avatar Owner',
        isActive: true,
        isVerified: true
      })
      .returning({ id: usersTable.id })
    const userId = avatarOwner!.id

    // -> Inserted directly rather than via `setAvatar()`: this suite is about the FK's own
    //    `onDelete: 'cascade'`, not the avatar-normalization path, so it needs no real image bytes.
    await fixtures.db
      .insert(userAvatarsTable)
      .values({ id: userId, data: Buffer.from('avatar-bytes'), hash: 'avatar-bytes-hash' })
    const beforeDelete = await fixtures.db
      .select()
      .from(userAvatarsTable)
      .where(eq(userAvatarsTable.id, userId))
    assert.equal(beforeDelete.length, 1)

    // -> Direct row delete, not `deleteUser()`: this is what proves the FK's own `onDelete: 'cascade'`
    //    is doing the work, rather than an app-level call site that happens to also clear the avatar.
    await fixtures.db.delete(usersTable).where(eq(usersTable.id, userId))

    const afterDelete = await fixtures.db
      .select()
      .from(userAvatarsTable)
      .where(eq(userAvatarsTable.id, userId))
    assert.equal(afterDelete.length, 0)
  })
})
