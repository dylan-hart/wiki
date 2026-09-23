import { after, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { login } from './login.ts'
import { users } from './users.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import {
  authentication as authenticationTable,
  userKeys,
  users as usersTable
} from '../db/schema.ts'
import { ensureTemporal } from '../test/temporal.ts'

describe('login.register (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let sendVerifyEmailMock: ReturnType<typeof mock.fn>
  let sendRegistrationAttemptNoticeMock: ReturnType<typeof mock.fn>

  const MODULE_KEY = 'local-test'
  // -> Stands in for a redirect-based module (SAML/OIDC/LDAP-delegation-style): `useForm: false`,
  //    as every non-local, non-LDAP module's `definition.yml` declares.
  const NON_FORM_MODULE_KEY = 'redirect-test'

  function req(): any {
    // -> `regenerate` is a no-op stub, not a `@fastify/session` fake: these tests assert on
    //    `afterLoginChecks`'s outcome, not on session-id churn. It only has to exist, since
    //    `updateSession` awaits it on any path that reaches one.
    return { session: { regenerate: async () => {} } }
  }

  async function createStrategy({
    module = MODULE_KEY,
    selfRegistration = true,
    autoProvision = false,
    allowedEmailRegex = '',
    allowedEmailDomains = [] as string[],
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
        allowedEmailDomains,
        autoEnrollGroups,
        config: { emailValidation }
      })
      .returning({ id: authenticationTable.id })
    const strategyId = row!.id
    // -> `register()` also checks the strategy is attached to the site the request came in on, and
    //    `getSiteById()` reads the in-memory `CARDINAL.sites` cache rather than the database, so the
    //    fixture site installed by `setupTestDb()` is what has to be updated here.
    if (attachToSite) {
      const site = (CARDINAL.sites as any)[fixtures.siteId]
      site.config.authStrategies = [
        ...(site.config.authStrategies ?? []),
        { id: strategyId, order: 0, isVisible: true }
      ]
    }
    return strategyId
  }

  /**
   * `afterLoginChecks()` looks the strategy up in `CARDINAL.auth.strategies`, not the database --
   * that is where a strategy's live module instance lives, and `enforceTfa` is read off it. A bare
   * stand-in is enough: nothing under test needs a real module instance, only a present one.
   */
  function registerLiveStrategy(strategyId: string, config: Record<string, any> = {}): void {
    ;(CARDINAL.auth.strategies as any)[strategyId] = { config }
  }

  function attachStrategyToSite(strategyId: string): void {
    ;(CARDINAL.sites[fixtures.siteId].config as Record<string, any>).authStrategies = [
      { id: strategyId, order: 0, isVisible: true }
    ]
  }

  before(async () => {
    // -> The `generateToken()`/`validateToken()` round trip uses `Temporal` throughout.
    await ensureTemporal()

    fixtures = await setupTestDb()
    const { mail } = await import('./mail.ts')
    sendVerifyEmailMock = mock.method(mail, 'sendVerifyEmail', async () => {})
    sendRegistrationAttemptNoticeMock = mock.method(
      mail,
      'sendRegistrationAttemptNotice',
      async () => {}
    )

    CARDINAL.data.authentication = [
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
    // -> `getActiveStrategies()` reads this unconditionally, to sort the built-in local strategy
    //    first. The creation tests below override it with their own strategy id, since that is the
    //    key `createUser()` stores the password blob under.
    CARDINAL.data.systemIds = { localAuthId: 'placeholder-local-auth-id' } as any
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
      login.register(
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
      login.register(
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
      login.register(
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
      login.register(
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
      login.register(
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
      (login as any).findOrCreateProviderUser(
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
      login.register(
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

  /**
   * `createStrategy` writes straight to the table, bypassing `authentication.ts#validateStrategy`'s
   * save-time ReDoS check, standing in for a pathological pattern saved before that check existed.
   * What matters is not the refusal but that it comes back within the test timeout rather than
   * hanging the event loop on the O(2^n) an unguarded `.test()` would take against this input.
   */
  test('refuses (quickly, not by hanging) a login against a catastrophic-backtracking allowedEmailRegex saved before the safety check existed', async () => {
    const strategyId = await createStrategy({ allowedEmailRegex: '^(a+)+$' })
    attachStrategyToSite(strategyId)

    const start = Date.now()
    await assert.rejects(
      login.register(
        {
          siteId: fixtures.siteId,
          strategyId,
          name: 'Ada Lovelace',
          email: `${'a'.repeat(60)}!@elsewhere.example`,
          password: 'longenough1'
        },
        req()
      ),
      /ERR_EMAIL_NOT_ALLOWED/
    )
    assert.ok(Date.now() - start < 2000, 'expected the guarded regex test to resolve quickly')
  })

  test('refuses an email whose domain is not on allowedEmailDomains', async () => {
    const strategyId = await createStrategy({ allowedEmailDomains: ['allowed.example'] })
    attachStrategyToSite(strategyId)

    await assert.rejects(
      login.register(
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

    assert.equal(await users.getByEmail('ada@elsewhere.example'), null)
  })

  test('accepts an email whose domain matches allowedEmailDomains case-insensitively', async () => {
    const strategyId = await createStrategy({
      allowedEmailDomains: ['allowed.example'],
      emailValidation: true
    })
    CARDINAL.data.systemIds = { localAuthId: strategyId } as any
    attachStrategyToSite(strategyId)

    const result = await login.register(
      {
        siteId: fixtures.siteId,
        strategyId,
        name: 'Ada Lovelace',
        email: 'ada@Allowed.Example',
        password: 'longenough1'
      },
      req()
    )

    assert.deepEqual(result, { nextAction: 'verify' })
    const created = await users.getByEmail('ada@allowed.example')
    assert.ok(created)
  })

  test('an empty allowedEmailDomains list leaves registration unrestricted', async () => {
    const strategyId = await createStrategy({ allowedEmailDomains: [], emailValidation: true })
    CARDINAL.data.systemIds = { localAuthId: strategyId } as any
    attachStrategyToSite(strategyId)

    const result = await login.register(
      {
        siteId: fixtures.siteId,
        strategyId,
        name: 'Ada Lovelace',
        email: 'ada@anywhere.example',
        password: 'longenough1'
      },
      req()
    )

    assert.deepEqual(result, { nextAction: 'verify' })
    assert.ok(await users.getByEmail('ada@anywhere.example'))
  })

  test('accepts and creates the account for an address matching allowedEmailRegex', async () => {
    const strategyId = await createStrategy({
      allowedEmailRegex: '^[^@]+@allowed\\.example$',
      emailValidation: false
    })
    CARDINAL.data.systemIds = { localAuthId: strategyId } as any
    attachStrategyToSite(strategyId)
    registerLiveStrategy(strategyId)

    // -> A distinct local-part: the `allowedEmailDomains` tests above already registered
    //    `ada@allowed.example` in this file's one shared database.
    const result = await login.register(
      {
        siteId: fixtures.siteId,
        strategyId,
        name: 'Katherine Johnson',
        email: 'katherine@allowed.example',
        password: 'longenough1'
      },
      req()
    )

    assert.equal(result.authenticated, true)
    assert.equal(result.nextAction, 'redirect')

    const created = await users.getByEmail('katherine@allowed.example')
    assert.ok(created)
    assert.equal(created!.name, 'Katherine Johnson')
  })

  test('matches allowedEmailRegex case-insensitively against the submitted address', async () => {
    // -> The pattern is lowercase, as an admin would enter it; the case-insensitivity comes from
    //    `register()` testing it against the already-lowercased `normalizedEmail`.
    const strategyId = await createStrategy({
      allowedEmailRegex: '^[^@]+@allowed\\.example$',
      emailValidation: false
    })
    CARDINAL.data.systemIds = { localAuthId: strategyId } as any
    attachStrategyToSite(strategyId)
    registerLiveStrategy(strategyId)

    const result = await login.register(
      {
        siteId: fixtures.siteId,
        strategyId,
        name: 'Grace Hopper',
        email: 'Grace.Hopper@Allowed.Example',
        password: 'longenough1'
      },
      req()
    )

    assert.equal(result.authenticated, true)

    const created = await users.getByEmail('grace.hopper@allowed.example')
    assert.ok(created)
  })

  test('a duplicate of an already-verified address, with emailValidation on, answers the same generic result a fresh registration would and notifies the real owner instead of confirming the address is taken', async () => {
    const strategyId = await createStrategy({ emailValidation: true })
    CARDINAL.data.systemIds = { localAuthId: strategyId } as any
    const request = req()

    const result = await login.register(
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

    const existing = await users.getByEmail('fixture@example.com')
    assert.equal(existing!.name, 'Fixture User')
  })

  test('a duplicate address on a strategy with emailValidation off still refuses as a duplicate -- no email step to route secrecy through', async () => {
    const strategyId = await createStrategy({ emailValidation: false })
    CARDINAL.data.systemIds = { localAuthId: strategyId } as any
    registerLiveStrategy(strategyId)

    await login.register(
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
      login.register(
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
    CARDINAL.data.systemIds = { localAuthId: strategyId } as any
    attachStrategyToSite(strategyId)
    const request = req()

    const result = await login.register(
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
    CARDINAL.data.systemIds = { localAuthId: strategyId } as any
    attachStrategyToSite(strategyId)
    registerLiveStrategy(strategyId)
    const request = req()

    const result = await login.register(
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
    assert.equal((created!.auth as Record<string, any>)[strategyId].isPasswordKnown, true)
    assert.equal(sendVerifyEmailMock.mock.calls.length, 0)
  })

  test('enrolls a new account into the strategy autoEnrollGroups', async () => {
    const strategyId = await createStrategy({
      emailValidation: false,
      autoEnrollGroups: [fixtures.groupId]
    })
    CARDINAL.data.systemIds = { localAuthId: strategyId } as any
    attachStrategyToSite(strategyId)
    registerLiveStrategy(strategyId)

    await login.register(
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
    CARDINAL.data.systemIds = { localAuthId: strategyId } as any
    attachStrategyToSite(strategyId)

    const first = await login.register(
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

    const second = await login.register(
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
