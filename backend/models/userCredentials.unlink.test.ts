import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import bcrypt from 'bcryptjs'
import { and, eq } from 'drizzle-orm'
import {
  assertUnlinkable,
  authLockKey,
  countAlternativeLogins,
  isLocalStrategy,
  userCredentials
} from './userCredentials.ts'
import { withAdvisoryLock } from '../helpers/advisoryLock.ts'
import { DISCONNECTED_AUTH_KEY, strategyEntries } from '../helpers/userAuthEntries.ts'
import { installTestWiki } from '../test/mocks.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { auditLog as auditLogTable, users as usersTable } from '../db/schema.ts'
import { ensureTemporal } from '../test/temporal.ts'

const LOCAL_ID = '10000000-0000-4000-8000-000000000001'
const OIDC_ID = '10000000-0000-4000-8000-000000000002'
const SAML_ID = '10000000-0000-4000-8000-000000000003'
const UNKNOWN_USER_ID = '20000000-0000-4000-8000-000000000001'
const DISABLED_ID = '10000000-0000-4000-8000-000000000004'

/** What `models/authentication.ts#activateStrategies()` leaves loaded: every strategy but `DISABLED_ID`. */
const LOADED_STRATEGIES = { [LOCAL_ID]: {}, [OIDC_ID]: {}, [SAML_ID]: {} }

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

describe('userCredentials.isLocalStrategy', () => {
  let wiki: { restore(): void }

  before(() => {
    wiki = installTestWiki({ data: { systemIds: { localAuthId: LOCAL_ID } } })
  })

  after(() => wiki.restore())

  test('the built-in local strategy id is local whatever module is reported', () => {
    assert.equal(isLocalStrategy(LOCAL_ID, undefined), true)
  })

  test('another strategy running the local module is local too', () => {
    assert.equal(isLocalStrategy(OIDC_ID, 'local'), true)
  })

  test('a redirect-based provider is not local', () => {
    assert.equal(isLocalStrategy(OIDC_ID, 'oidc'), false)
  })

  test('a strategy that no longer exists is not local', () => {
    assert.equal(isLocalStrategy(OIDC_ID, null), false)
  })
})

describe('userCredentials.assertUnlinkable', () => {
  let wiki: { restore(): void }

  before(() => {
    wiki = installTestWiki({
      config: { security: { allowPasskeys: true } },
      auth: { strategies: LOADED_STRATEGIES }
    })
  })

  after(() => wiki.restore())

  test('refuses a strategy the user has no entry for', () => {
    const user = { auth: { [LOCAL_ID]: { password: 'x' } } }
    assert.throws(() => assertUnlinkable(user, OIDC_ID), /ERR_UNLINK_NOT_LINKED/)
  })

  test('refuses the last way into the account', () => {
    const user = { auth: { [OIDC_ID]: { id: 'p1' } } }
    assert.throws(() => assertUnlinkable(user, OIDC_ID), /ERR_UNLINK_LAST_LOGIN_METHOD/)
  })

  test('a restricted password login does not count as another way in', () => {
    const user = { auth: { [LOCAL_ID]: { restrictLogin: true }, [OIDC_ID]: { id: 'p1' } } }
    assert.throws(() => assertUnlinkable(user, OIDC_ID), /ERR_UNLINK_LAST_LOGIN_METHOD/)
  })

  test('a passkey counts as another way in', () => {
    const user = {
      auth: { [LOCAL_ID]: { restrictLogin: true }, [OIDC_ID]: { id: 'p1' } },
      passkeys: { authenticators: [{ id: 'k1' }] }
    }
    assert.doesNotThrow(() => assertUnlinkable(user, OIDC_ID))
  })

  test('another linked provider counts as another way in', () => {
    const user = { auth: { [OIDC_ID]: { id: 'p1' }, [SAML_ID]: { id: 'p2' } } }
    assert.doesNotThrow(() => assertUnlinkable(user, OIDC_ID))
  })

  test('a provider whose strategy is disabled or deleted does not count', () => {
    const user = { auth: { [OIDC_ID]: { id: 'p1' }, [DISABLED_ID]: { id: 'p2' } } }
    assert.throws(() => assertUnlinkable(user, OIDC_ID), /ERR_UNLINK_LAST_LOGIN_METHOD/)
  })

  test('a password the account holder knows counts as another way in', () => {
    const user = {
      auth: { [LOCAL_ID]: { password: 'hash', isPasswordKnown: true }, [OIDC_ID]: { id: 'p1' } }
    }
    assert.doesNotThrow(() => assertUnlinkable(user, OIDC_ID))
  })

  test('the random password a provider-provisioned account was given does not count', () => {
    const user = {
      auth: { [LOCAL_ID]: { password: 'hash', isPasswordKnown: false }, [OIDC_ID]: { id: 'p1' } }
    }
    assert.throws(() => assertUnlinkable(user, OIDC_ID), /ERR_UNLINK_LAST_LOGIN_METHOD/)
  })

  test('a password with no record of being known does not count', () => {
    const user = { auth: { [LOCAL_ID]: { password: 'hash' }, [OIDC_ID]: { id: 'p1' } } }
    assert.throws(() => assertUnlinkable(user, OIDC_ID), /ERR_UNLINK_LAST_LOGIN_METHOD/)
  })
})

describe('userCredentials.unlinkStrategy refuses the local strategy before touching the account', () => {
  let wiki: { restore(): void }
  let getByIdCalls: number

  before(() => {
    getByIdCalls = 0
    wiki = installTestWiki({
      data: { systemIds: { localAuthId: LOCAL_ID } },
      models: {
        authentication: {
          getStrategyById: async (id: string) => ({ id, module: 'local' })
        },
        users: {
          getById: async () => {
            getByIdCalls++
            return null
          }
        }
      }
    })
  })

  after(() => wiki.restore())

  test('the built-in local strategy', async () => {
    await assert.rejects(
      userCredentials.unlinkStrategy({
        userId: UNKNOWN_USER_ID,
        strategyId: LOCAL_ID,
        actor: { id: null, name: '' }
      }),
      /ERR_UNLINK_LOCAL_STRATEGY/
    )
    assert.equal(getByIdCalls, 0)
  })

  test('a second instance of the local module', async () => {
    await assert.rejects(
      userCredentials.unlinkStrategy({
        userId: UNKNOWN_USER_ID,
        strategyId: OIDC_ID,
        actor: { id: null, name: '' }
      }),
      /ERR_UNLINK_LOCAL_STRATEGY/
    )
    assert.equal(getByIdCalls, 0)
  })
})

describe('userCredentials.describeLinkedProviders reports canDisconnect', () => {
  let wiki: { restore(): void }

  before(() => {
    wiki = installTestWiki({
      config: { security: { allowPasskeys: true } },
      auth: { strategies: LOADED_STRATEGIES },
      data: {
        systemIds: { localAuthId: LOCAL_ID },
        authentication: [
          { key: 'local', title: 'Local', icon: '' },
          { key: 'oidc', title: 'OpenID Connect', icon: '' }
        ]
      },
      db: {
        select: () => ({
          from: async () => [
            { id: LOCAL_ID, module: 'local', displayName: 'Local', config: {} },
            { id: OIDC_ID, module: 'oidc', displayName: 'Okta', config: {} },
            { id: SAML_ID, module: 'oidc', displayName: 'Azure', config: {} }
          ]
        })
      }
    })
  })

  after(() => wiki.restore())

  function byId(providers: Array<{ authId: string; config: any }>) {
    return Object.fromEntries(providers.map((p) => [p.authId, p.config.canDisconnect]))
  }

  test('the local strategy is never disconnectable, a provider with another way in is', async () => {
    const user = {
      auth: { [LOCAL_ID]: { password: 'hash', isPasswordKnown: true }, [OIDC_ID]: { id: 'p1' } }
    }
    const expected = { [LOCAL_ID]: false, [OIDC_ID]: true }
    assert.deepEqual(
      byId(await userCredentials.describeLinkedProviders(user, { forProfile: true })),
      expected
    )
    assert.deepEqual(byId(await userCredentials.describeLinkedProviders(user)), expected)
  })

  test('the last way into the account is not disconnectable', async () => {
    const user = { auth: { [LOCAL_ID]: { restrictLogin: true }, [OIDC_ID]: { id: 'p1' } } }
    assert.deepEqual(
      byId(await userCredentials.describeLinkedProviders(user, { forProfile: true })),
      { [LOCAL_ID]: false, [OIDC_ID]: false }
    )
  })

  test('a provider-provisioned account cannot disconnect its only provider', async () => {
    const user = {
      auth: { [LOCAL_ID]: { password: 'hash', isPasswordKnown: false }, [OIDC_ID]: { id: 'p1' } }
    }
    const expected = { [LOCAL_ID]: false, [OIDC_ID]: false }
    assert.deepEqual(
      byId(await userCredentials.describeLinkedProviders(user, { forProfile: true })),
      expected
    )
    assert.deepEqual(byId(await userCredentials.describeLinkedProviders(user)), expected)
  })

  test('a provider is not disconnectable when the only other is disabled', async () => {
    const user = { auth: { [OIDC_ID]: { id: 'p1' }, [DISABLED_ID]: { id: 'p2' } } }
    assert.equal(byId(await userCredentials.describeLinkedProviders(user))[OIDC_ID], false)
  })

  test('two providers each leave the other as a way in', async () => {
    const user = { auth: { [OIDC_ID]: { id: 'p1' }, [SAML_ID]: { id: 'p2' } } }
    assert.deepEqual(byId(await userCredentials.describeLinkedProviders(user)), {
      [OIDC_ID]: true,
      [SAML_ID]: true
    })
  })

  test('a stored entry cannot override the computed value in the admin view', async () => {
    const user = {
      auth: { [LOCAL_ID]: { restrictLogin: true }, [OIDC_ID]: { id: 'p1', canDisconnect: true } }
    }
    assert.equal(byId(await userCredentials.describeLinkedProviders(user))[OIDC_ID], false)
  })
})

describe('userCredentials.unlinkStrategy (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let usersModel: typeof import('./users.ts').users
  let mailModel: typeof import('./mail.ts').mail

  before(async () => {
    ;({ users: usersModel } = await import('./users.ts'))
    ;({ mail: mailModel } = await import('./mail.ts'))
    await ensureTemporal()
    CARDINAL.data.systemIds = { ...CARDINAL.data.systemIds, localAuthId: LOCAL_ID } as any
    CARDINAL.auth.strategies = { ...LOADED_STRATEGIES } as any
  })

  async function seedUser(auth: Record<string, any>): Promise<string> {
    const [row] = await fixtures.db
      .insert(usersTable)
      .values({
        email: `unlink-${Math.random().toString(36).slice(2)}@example.com`,
        name: 'Unlink User',
        isActive: true,
        isVerified: true,
        auth
      })
      .returning({ id: usersTable.id })
    return row!.id
  }

  async function authOf(userId: string): Promise<Record<string, any>> {
    return ((await usersModel.getById(userId)) as any).auth
  }

  test('removes the entry, records the actor and notifies the account holder', async (t) => {
    const sendMock = t.mock.method(mailModel, 'sendSignInMethodRemoved', async () => {})
    const userId = await seedUser({
      [LOCAL_ID]: { password: 'hash', isPasswordKnown: true },
      [OIDC_ID]: { id: 'provider-1', email: 'x@example.com' }
    })

    await userCredentials.unlinkStrategy({
      userId,
      strategyId: OIDC_ID,
      actor: { id: fixtures.userId, name: 'Fixture User', email: 'fixture@example.com' }
    })

    const auth = await authOf(userId)
    assert.equal(auth[OIDC_ID], undefined)
    assert.deepEqual(auth[LOCAL_ID], { password: 'hash', isPasswordKnown: true })

    const entries = await fixtures.db
      .select()
      .from(auditLogTable)
      .where(
        and(eq(auditLogTable.event, 'user.signInMethodRemoved'), eq(auditLogTable.targetId, userId))
      )
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.actorId, fixtures.userId)
    assert.deepEqual(entries[0]!.detail, {
      strategyId: OIDC_ID,
      strategyKey: 'unknown',
      byAdmin: true
    })
    assert.doesNotMatch(JSON.stringify(entries[0]!.detail), /provider-1/)

    assert.equal(sendMock.mock.callCount(), 1)
    assert.equal((sendMock.mock.calls[0]!.arguments[0] as any).userId, userId)
  })

  test('a removal by the account holder records byAdmin: false', async (t) => {
    t.mock.method(mailModel, 'sendSignInMethodRemoved', async () => {})
    const userId = await seedUser({
      [LOCAL_ID]: { password: 'hash', isPasswordKnown: true },
      [OIDC_ID]: { id: 'p' }
    })

    await userCredentials.unlinkStrategy({
      userId,
      strategyId: OIDC_ID,
      actor: { id: userId, name: 'Unlink User' }
    })

    const [entry] = await fixtures.db
      .select()
      .from(auditLogTable)
      .where(
        and(eq(auditLogTable.event, 'user.signInMethodRemoved'), eq(auditLogTable.targetId, userId))
      )
    assert.equal((entry!.detail as any).byAdmin, false)
  })

  test('still removes the entry when the notice fails to send', async (t) => {
    t.mock.method(mailModel, 'sendSignInMethodRemoved', async () => {
      throw new Error('ERR_MAIL_NOT_CONFIGURED')
    })
    const userId = await seedUser({
      [LOCAL_ID]: { password: 'hash', isPasswordKnown: true },
      [OIDC_ID]: { id: 'p' }
    })

    await userCredentials.unlinkStrategy({
      userId,
      strategyId: OIDC_ID,
      actor: { id: userId, name: 'Unlink User' }
    })

    assert.equal((await authOf(userId))[OIDC_ID], undefined)
  })

  test('refuses a strategy that is not linked, writing and sending nothing', async (t) => {
    const sendMock = t.mock.method(mailModel, 'sendSignInMethodRemoved', async () => {})
    const userId = await seedUser({ [LOCAL_ID]: { password: 'hash' } })

    await assert.rejects(
      userCredentials.unlinkStrategy({
        userId,
        strategyId: OIDC_ID,
        actor: { id: userId, name: 'Unlink User' }
      }),
      /ERR_UNLINK_NOT_LINKED/
    )
    assert.equal(sendMock.mock.callCount(), 0)
  })

  test('refuses the last way into the account, leaving it linked', async (t) => {
    const sendMock = t.mock.method(mailModel, 'sendSignInMethodRemoved', async () => {})
    const userId = await seedUser({ [OIDC_ID]: { id: 'p' } })

    await assert.rejects(
      userCredentials.unlinkStrategy({
        userId,
        strategyId: OIDC_ID,
        actor: { id: userId, name: 'Unlink User' }
      }),
      /ERR_UNLINK_LAST_LOGIN_METHOD/
    )
    assert.deepEqual((await authOf(userId))[OIDC_ID], { id: 'p' })
    assert.equal(sendMock.mock.callCount(), 0)
  })

  test('refuses when the only other provider belongs to a disabled strategy', async (t) => {
    const sendMock = t.mock.method(mailModel, 'sendSignInMethodRemoved', async () => {})
    const userId = await seedUser({ [OIDC_ID]: { id: 'p' }, [DISABLED_ID]: { id: 'q' } })

    await assert.rejects(
      userCredentials.unlinkStrategy({
        userId,
        strategyId: OIDC_ID,
        actor: { id: userId, name: 'Unlink User' }
      }),
      /ERR_UNLINK_LAST_LOGIN_METHOD/
    )
    assert.deepEqual((await authOf(userId))[OIDC_ID], { id: 'p' })
    assert.equal(sendMock.mock.callCount(), 0)
  })

  test('refuses an account that does not exist', async () => {
    await assert.rejects(
      userCredentials.unlinkStrategy({
        userId: UNKNOWN_USER_ID,
        strategyId: OIDC_ID,
        actor: { id: null, name: '' }
      }),
      /ERR_INVALID_USER/
    )
  })

  test('two concurrent removals of the only two providers cannot both succeed', async (t) => {
    t.mock.method(mailModel, 'sendSignInMethodRemoved', async () => {})
    const userId = await seedUser({ [OIDC_ID]: { id: 'p1' }, [SAML_ID]: { id: 'p2' } })
    const actor = { id: userId, name: 'Unlink User' }

    const results = await Promise.allSettled([
      userCredentials.unlinkStrategy({ userId, strategyId: OIDC_ID, actor }),
      userCredentials.unlinkStrategy({ userId, strategyId: SAML_ID, actor })
    ])

    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    assert.match(rejected.reason.message, /ERR_UNLINK_LAST_LOGIN_METHOD/)
    assert.equal(strategyEntries(await authOf(userId)).length, 1)
  })

  describe('an account a provider provisioned', () => {
    let loginModel: any

    before(async () => {
      loginModel = (await import('./login.ts')).login
    })

    async function provision(): Promise<string> {
      const user = await loginModel.findOrCreateProviderUser(
        {
          id: OIDC_ID,
          module: 'test-oidc',
          displayName: 'Test Provider',
          isEnabled: true,
          autoProvision: true,
          allowedEmailRegex: '',
          autoEnrollGroups: [],
          trustEmailForLinking: false,
          config: {}
        },
        {
          id: `sso-${Math.random().toString(36).slice(2)}`,
          email: `sso-${Math.random().toString(36).slice(2)}@example.com`,
          name: 'Provisioned User'
        }
      )
      return user.id
    }

    function unlink(userId: string) {
      return userCredentials.unlinkStrategy({
        userId,
        strategyId: OIDC_ID,
        actor: { id: userId, name: 'Provisioned User' }
      })
    }

    test('cannot disconnect its only provider', async (t) => {
      const sendMock = t.mock.method(mailModel, 'sendSignInMethodRemoved', async () => {})
      const userId = await provision()

      await assert.rejects(unlink(userId), /ERR_UNLINK_LAST_LOGIN_METHOD/)
      assert.ok((await authOf(userId))[OIDC_ID])
      assert.equal(sendMock.mock.callCount(), 0)
    })

    test('can, once an administrator has set it a password', async (t) => {
      t.mock.method(mailModel, 'sendSignInMethodRemoved', async () => {})
      const userId = await provision()
      await userCredentials.setUserPassword({ id: userId, newPassword: 'adminchosen1' })

      await unlink(userId)
      assert.equal((await authOf(userId))[OIDC_ID], undefined)
    })
  })

  test('a registered local account can disconnect a provider it linked', async (t) => {
    t.mock.method(mailModel, 'sendSignInMethodRemoved', async () => {})
    const userId = await usersModel.createUser({
      name: 'Registered User',
      email: `registered-${Math.random().toString(36).slice(2)}@example.com`,
      password: 'chosenpwd1'
    })
    await userCredentials.patchStrategyAuth(userId, OIDC_ID, () => ({ id: 'linked-provider' }))

    await userCredentials.unlinkStrategy({
      userId,
      strategyId: OIDC_ID,
      actor: { id: userId, name: 'Registered User' }
    })
    assert.equal((await authOf(userId))[OIDC_ID], undefined)
  })

  test('changing its own password makes a password with no record of being known count', async () => {
    const userId = await seedUser({
      [LOCAL_ID]: { password: await bcrypt.hash('currentpwd1', 4) },
      [OIDC_ID]: { id: 'p' }
    })

    await userCredentials.changeOwnPassword({
      userId,
      strategyId: LOCAL_ID,
      currentPassword: 'currentpwd1',
      newPassword: 'brandnewpwd1'
    })
    assert.equal((await authOf(userId))[LOCAL_ID].isPasswordKnown, true)
  })

  test('an administrator setting a password marks it known', async () => {
    const userId = await seedUser({
      [LOCAL_ID]: { password: 'hash', isPasswordKnown: false },
      [OIDC_ID]: { id: 'p' }
    })

    await userCredentials.setUserPassword({ id: userId, newPassword: 'adminchosen1' })
    assert.equal((await authOf(userId))[LOCAL_ID].isPasswordKnown, true)
  })

  describe('setPasswordLoginEnabled', () => {
    function localStrategy(t: any): void {
      t.mock.method(CARDINAL.models.authentication, 'getStrategyById', async (id: string) => ({
        id,
        module: id === LOCAL_ID ? 'local' : 'test-oidc'
      }))
    }

    test('turns password login off while a provider remains a way in', async (t) => {
      localStrategy(t)
      const userId = await seedUser({
        [LOCAL_ID]: { password: 'hash', isPasswordKnown: true },
        [OIDC_ID]: { id: 'p' }
      })

      await userCredentials.setPasswordLoginEnabled({
        userId,
        strategyId: LOCAL_ID,
        isEnabled: false
      })
      assert.equal((await authOf(userId))[LOCAL_ID].restrictLogin, true)
    })

    test('refuses to turn it off when nothing else signs the account in', async (t) => {
      localStrategy(t)
      const userId = await seedUser({ [LOCAL_ID]: { password: 'hash', isPasswordKnown: true } })

      await assert.rejects(
        userCredentials.setPasswordLoginEnabled({
          userId,
          strategyId: LOCAL_ID,
          isEnabled: false
        }),
        /ERR_NO_OTHER_LOGIN_METHOD/
      )
      assert.equal((await authOf(userId))[LOCAL_ID].restrictLogin, undefined)
    })

    test('refuses an account that does not exist', async (t) => {
      localStrategy(t)
      await assert.rejects(
        userCredentials.setPasswordLoginEnabled({
          userId: UNKNOWN_USER_ID,
          strategyId: LOCAL_ID,
          isEnabled: false
        }),
        /ERR_INVALID_USER/
      )
    })

    test('checks the row as it is once the lock is held, not as it was before', async (t) => {
      localStrategy(t)
      const userId = await seedUser({
        [LOCAL_ID]: { password: 'hash', isPasswordKnown: true },
        [OIDC_ID]: { id: 'p' }
      })

      let pending!: Promise<void>
      await withAdvisoryLock(authLockKey(userId), async () => {
        pending = userCredentials.setPasswordLoginEnabled({
          userId,
          strategyId: LOCAL_ID,
          isEnabled: false
        })
        pending.catch(() => {})
        // -> Long enough for a read taken outside the lock to have happened already; then the
        //    provider goes, the way a concurrent `unlinkStrategy()` holding the lock would take it
        await delay(300)
        await fixtures.db
          .update(usersTable)
          .set({ auth: { [LOCAL_ID]: { password: 'hash', isPasswordKnown: true } } })
          .where(eq(usersTable.id, userId))
      })

      await assert.rejects(pending, /ERR_NO_OTHER_LOGIN_METHOD/)
      assert.equal((await authOf(userId))[LOCAL_ID].restrictLogin, undefined)
    })

    test('and a concurrent disconnect of the only provider cannot both succeed', async (t) => {
      localStrategy(t)
      t.mock.method(mailModel, 'sendSignInMethodRemoved', async () => {})
      const userId = await seedUser({
        [LOCAL_ID]: { password: 'hash', isPasswordKnown: true },
        [OIDC_ID]: { id: 'p' }
      })

      const results = await Promise.allSettled([
        userCredentials.setPasswordLoginEnabled({ userId, strategyId: LOCAL_ID, isEnabled: false }),
        userCredentials.unlinkStrategy({
          userId,
          strategyId: OIDC_ID,
          actor: { id: userId, name: 'Unlink User' }
        })
      ])

      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
      const auth = await authOf(userId)
      assert.ok(auth[OIDC_ID] || !auth[LOCAL_ID].restrictLogin)
    })
  })

  describe('a disconnected identity at its next login', () => {
    let loginModel: any

    before(async () => {
      loginModel = (await import('./login.ts')).login
    })

    function strategy(trustEmailForLinking: boolean): any {
      return {
        id: OIDC_ID,
        module: 'test-oidc',
        displayName: 'Test Provider',
        isEnabled: true,
        autoProvision: true,
        allowedEmailRegex: '',
        autoEnrollGroups: [],
        trustEmailForLinking,
        config: {}
      }
    }

    // -> One per test: `users.getByProviderLink()` resolves an identity to the first account holding
    //    it, and every test here shares the one schema
    function freshIdentity(): string {
      return `provider-${Math.random().toString(36).slice(2)}`
    }

    async function seedAndUnlink(
      t: any
    ): Promise<{ userId: string; email: string; identity: string }> {
      t.mock.method(mailModel, 'sendSignInMethodRemoved', async () => {})
      const identity = freshIdentity()
      const userId = await seedUser({
        [LOCAL_ID]: { password: 'hash', isPasswordKnown: true },
        [OIDC_ID]: { id: identity }
      })
      const email = ((await usersModel.getById(userId)) as any).email
      await userCredentials.unlinkStrategy({
        userId,
        strategyId: OIDC_ID,
        actor: { id: userId, name: 'Unlink User' }
      })
      return { userId, email, identity }
    }

    test('is refused with ERR_ACCOUNT_NOT_LINKED while trustEmailForLinking is off', async (t) => {
      const { email, identity } = await seedAndUnlink(t)
      await assert.rejects(
        loginModel.findOrCreateProviderUser(strategy(false), {
          id: identity,
          email,
          name: 'Unlink User'
        }),
        /ERR_ACCOUNT_NOT_LINKED/
      )
    })

    function signInMethodAddedFor(userId: string) {
      return fixtures.db
        .select()
        .from(auditLogTable)
        .where(
          and(eq(auditLogTable.event, 'user.signInMethodAdded'), eq(auditLogTable.targetId, userId))
        )
    }

    test('is refused even while trustEmailForLinking is on, with no link, audit entry or notice', async (t) => {
      const { userId, email, identity } = await seedAndUnlink(t)
      const sendMock = t.mock.method(mailModel, 'sendSignInMethodAdded', async () => {})

      await assert.rejects(
        loginModel.findOrCreateProviderUser(strategy(true), {
          id: identity,
          email,
          name: 'Unlink User'
        }),
        /ERR_ACCOUNT_NOT_LINKED/
      )
      assert.equal((await authOf(userId))[OIDC_ID], undefined)
      assert.equal((await signInMethodAddedFor(userId)).length, 0)
      assert.equal(sendMock.mock.callCount(), 0)
    })

    test('records the disconnect without it reading as a sign-in method anywhere', async (t) => {
      const { userId } = await seedAndUnlink(t)
      const user = await usersModel.getById(userId)

      assert.ok((user as any).auth[DISCONNECTED_AUTH_KEY][OIDC_ID])
      assert.deepEqual(
        (await userCredentials.describeLinkedProviders(user)).map((p) => p.authId),
        [LOCAL_ID]
      )
      assert.equal(countAlternativeLogins(user, LOCAL_ID), 0)
    })

    test('is let in again once the account holder reconnects it through the connect flow', async (t) => {
      const { userId, email, identity } = await seedAndUnlink(t)
      t.mock.method(mailModel, 'sendSignInMethodAdded', async () => {})

      await userCredentials.linkStrategy({
        userId,
        strategyId: OIDC_ID,
        identity: { id: identity, email },
        methodName: 'Test Provider'
      })
      assert.equal((await authOf(userId))[DISCONNECTED_AUTH_KEY], undefined)

      const result = await loginModel.findOrCreateProviderUser(strategy(false), {
        id: identity,
        email,
        name: 'Unlink User'
      })
      assert.equal(result.id, userId)
    })

    test('reconnecting one provider leaves another still disconnected', async (t) => {
      t.mock.method(mailModel, 'sendSignInMethodRemoved', async () => {})
      t.mock.method(mailModel, 'sendSignInMethodAdded', async () => {})
      const userId = await seedUser({
        [LOCAL_ID]: { password: 'hash', isPasswordKnown: true },
        [OIDC_ID]: { id: freshIdentity() },
        [SAML_ID]: { id: freshIdentity() }
      })
      const actor = { id: userId, name: 'Unlink User' }
      await userCredentials.unlinkStrategy({ userId, strategyId: OIDC_ID, actor })
      await userCredentials.unlinkStrategy({ userId, strategyId: SAML_ID, actor })

      await userCredentials.linkStrategy({
        userId,
        strategyId: OIDC_ID,
        identity: { id: freshIdentity(), email: 'x@example.com' },
        methodName: 'Test Provider'
      })
      assert.deepEqual(Object.keys((await authOf(userId))[DISCONNECTED_AUTH_KEY]), [SAML_ID])
    })

    test('a disconnect landing mid-login is not undone by that login', async () => {
      const identity = freshIdentity()
      const userId = await seedUser({
        [LOCAL_ID]: { password: 'hash', isPasswordKnown: true },
        [OIDC_ID]: { id: identity }
      })
      const email = ((await usersModel.getById(userId)) as any).email

      let pending!: Promise<any>
      await withAdvisoryLock(authLockKey(userId), async () => {
        pending = loginModel.findOrCreateProviderUser(strategy(true), {
          id: identity,
          email,
          name: 'Unlink User'
        })
        pending.catch(() => {})
        // -> Long enough for the login's own read to have found the stored link; then the
        //    disconnect lands, the way `unlinkStrategy()` holding the lock would write it
        await delay(300)
        await fixtures.db
          .update(usersTable)
          .set({
            auth: {
              [LOCAL_ID]: { password: 'hash', isPasswordKnown: true },
              [DISCONNECTED_AUTH_KEY]: { [OIDC_ID]: '2026-09-23T00:00:00.000Z' }
            }
          })
          .where(eq(usersTable.id, userId))
      })

      await assert.rejects(pending, /ERR_ACCOUNT_NOT_LINKED/)
      assert.equal((await authOf(userId))[OIDC_ID], undefined)
    })
  })

  describe('an account trustEmailForLinking binds for the first time', () => {
    let loginModel: any

    before(async () => {
      loginModel = (await import('./login.ts')).login
    })

    test('is audited and mailed as the connect flow is', async (t) => {
      const sendMock = t.mock.method(mailModel, 'sendSignInMethodAdded', async () => {})
      const userId = await seedUser({ [LOCAL_ID]: { password: 'hash', isPasswordKnown: true } })
      const email = ((await usersModel.getById(userId)) as any).email

      const result = await loginModel.findOrCreateProviderUser(
        {
          id: OIDC_ID,
          module: 'test-oidc',
          displayName: 'Test Provider',
          isEnabled: true,
          autoProvision: false,
          allowedEmailRegex: '',
          autoEnrollGroups: [],
          trustEmailForLinking: true,
          config: {}
        },
        { id: `provider-${Math.random().toString(36).slice(2)}`, email, name: 'Unlink User' },
        { siteId: fixtures.siteId, ip: '203.0.113.7' }
      )
      assert.equal(result.id, userId)

      const entries = await fixtures.db
        .select()
        .from(auditLogTable)
        .where(
          and(eq(auditLogTable.event, 'user.signInMethodAdded'), eq(auditLogTable.targetId, userId))
        )
      assert.equal(entries.length, 1)
      assert.equal(entries[0]!.actorId, userId)
      assert.deepEqual(entries[0]!.detail, { strategyId: OIDC_ID, trustedEmail: true })

      assert.equal(sendMock.mock.callCount(), 1)
      const notice = sendMock.mock.calls[0]!.arguments[0] as any
      assert.equal(notice.to, email)
      assert.equal(notice.methodName, 'Test Provider')
      assert.equal(notice.siteId, fixtures.siteId)
    })

    test('a returning login through the stored link announces nothing', async (t) => {
      const sendMock = t.mock.method(mailModel, 'sendSignInMethodAdded', async () => {})
      const identity = `provider-${Math.random().toString(36).slice(2)}`
      const userId = await seedUser({
        [LOCAL_ID]: { password: 'hash', isPasswordKnown: true },
        [OIDC_ID]: { id: identity }
      })
      const email = ((await usersModel.getById(userId)) as any).email

      await loginModel.findOrCreateProviderUser(
        {
          id: OIDC_ID,
          module: 'test-oidc',
          displayName: 'Test Provider',
          isEnabled: true,
          autoProvision: false,
          allowedEmailRegex: '',
          autoEnrollGroups: [],
          trustEmailForLinking: true,
          config: {}
        },
        { id: identity, email, name: 'Unlink User' }
      )
      assert.equal(sendMock.mock.callCount(), 0)
    })
  })
})
