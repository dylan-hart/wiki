import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq } from 'drizzle-orm'
import { userCredentials } from './userCredentials.ts'
import { installTestWiki } from '../test/mocks.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { auditLog as auditLogTable, users as usersTable } from '../db/schema.ts'
import { ensureTemporal } from '../test/temporal.ts'

describe('userCredentials.linkStrategy (stubbed storage)', () => {
  const USER_ID = 'user-1'
  const STRATEGY_ID = 'strategy-gh'

  let auth: Record<string, any> | null
  let holder: { id: string } | null
  let record: ReturnType<typeof mock.fn>
  let send: ReturnType<typeof mock.fn>
  let warn: ReturnType<typeof mock.fn>
  let wiki: { restore(): void }

  beforeEach(() => {
    auth = { 'local-id': { password: 'hash' } }
    holder = null
    record = mock.fn(async () => {})
    send = mock.fn(async () => {})
    warn = mock.fn()
    wiki = installTestWiki({
      logger: { warn, info: mock.fn(), debug: mock.fn() },
      models: {
        flags: { authDebug: () => {} },
        users: {
          getById: async (id: string) =>
            id === USER_ID && auth
              ? {
                  id,
                  name: 'Ada',
                  email: 'ada@example.com',
                  prefs: { locale: 'fr' },
                  auth
                }
              : null,
          getByProviderLink: async () => holder
        },
        auditLog: { record },
        mail: { sendSignInMethodAdded: send }
      }
    })
    mock.method(
      userCredentials,
      'patchStrategyAuth',
      async (_userId: string, strategyId: string, mutate: (entry: any) => any) => {
        if (!auth) {
          return false
        }
        const patch = await mutate(auth[strategyId])
        if (patch === null) {
          return false
        }
        auth[strategyId] = { ...auth[strategyId], ...patch }
        return true
      }
    )
  })

  afterEach(() => {
    mock.restoreAll()
    wiki.restore()
  })

  function link(overrides: Record<string, any> = {}) {
    return userCredentials.linkStrategy({
      userId: USER_ID,
      strategyId: STRATEGY_ID,
      identity: { id: 'gh-42', email: 'other@example.org' },
      methodName: 'GitHub',
      siteId: 'site-1',
      ip: '203.0.113.9',
      ...overrides
    })
  }

  test('writes the provider identity, records the audit entry and notifies the account holder', async () => {
    await link()

    assert.deepEqual(auth![STRATEGY_ID], { id: 'gh-42', email: 'other@example.org' })

    assert.equal(record.mock.calls.length, 1)
    const entry = record.mock.calls[0]!.arguments[0] as any
    assert.equal(entry.event, 'user.signInMethodAdded')
    assert.equal(entry.targetType, 'user')
    assert.equal(entry.targetId, USER_ID)
    assert.deepEqual(entry.actor, {
      id: USER_ID,
      name: 'Ada',
      email: 'ada@example.com',
      ip: '203.0.113.9'
    })
    assert.deepEqual(entry.detail, { strategyId: STRATEGY_ID })
    assert.equal(entry.siteId, 'site-1')

    assert.equal(send.mock.calls.length, 1)
    const mail = send.mock.calls[0]!.arguments[0] as any
    assert.equal(mail.to, 'ada@example.com')
    assert.equal(mail.methodName, 'GitHub')
    assert.equal(mail.userId, USER_ID)
    assert.equal(mail.locale, 'fr')
    assert.equal(mail.siteId, 'site-1')
  })

  test('refuses a strategy the account already has an entry for, writing nothing', async () => {
    auth![STRATEGY_ID] = { id: 'gh-1', email: 'ada@example.com' }

    await assert.rejects(link(), /ERR_LINK_ALREADY_LINKED/)

    assert.deepEqual(auth![STRATEGY_ID], { id: 'gh-1', email: 'ada@example.com' })
    assert.equal(record.mock.calls.length, 0)
    assert.equal(send.mock.calls.length, 0)
  })

  test('refuses an identity already linked to a different account', async () => {
    holder = { id: 'user-2' }

    await assert.rejects(link(), /ERR_LINK_IDENTITY_IN_USE/)

    assert.equal(auth![STRATEGY_ID], undefined)
    assert.equal(record.mock.calls.length, 0)
    assert.equal(send.mock.calls.length, 0)
  })

  test('refuses when the account no longer exists', async () => {
    auth = null

    await assert.rejects(link(), /ERR_LINK_NOT_SIGNED_IN/)

    assert.equal(record.mock.calls.length, 0)
  })

  test('a notice that fails to send does not undo or fail the link', async () => {
    send = mock.fn(async () => {
      throw new Error('ERR_MAIL_NOT_CONFIGURED')
    })
    ;(CARDINAL.models as any).mail = { sendSignInMethodAdded: send }

    await link()

    assert.equal(auth![STRATEGY_ID].id, 'gh-42')
    assert.equal(record.mock.calls.length, 1)
    assert.equal(warn.mock.calls.length, 1)
  })

  test('keeps provider tokens out of the audit entry', async () => {
    await link({
      identity: { id: 'gh-42', email: 'other@example.org', idToken: 'SECRET-ID-TOKEN' } as any
    })

    const entry = record.mock.calls[0]!.arguments[0] as any
    assert.ok(!JSON.stringify(entry).includes('SECRET-ID-TOKEN'))
    assert.ok(!JSON.stringify(auth).includes('SECRET-ID-TOKEN'))
  })
})

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

describe('userCredentials.linkStrategy (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let usersModel: typeof import('./users.ts').users

  before(async () => {
    ;({ users: usersModel } = await import('./users.ts'))
    await ensureTemporal()
  })

  function freshStrategyId(): string {
    return `strategy-${Math.random().toString(36).slice(2)}`
  }

  test('writes the entry and records user.signInMethodAdded', async (t) => {
    const { mail } = await import('./mail.ts')
    const sendMock = t.mock.method(mail, 'sendSignInMethodAdded', async () => {})
    const strategyId = freshStrategyId()

    await userCredentials.linkStrategy({
      userId: fixtures.userId,
      strategyId,
      identity: { id: 'provider-77', email: 'elsewhere@example.org' },
      methodName: 'Provider'
    })

    const reloaded = (await usersModel.getById(fixtures.userId)) as any
    assert.deepEqual(reloaded.auth[strategyId], {
      id: 'provider-77',
      email: 'elsewhere@example.org'
    })
    const rows = await fixtures.db
      .select()
      .from(auditLogTable)
      .where(
        and(
          eq(auditLogTable.event, 'user.signInMethodAdded'),
          eq(auditLogTable.targetId, fixtures.userId)
        )
      )
    assert.ok(rows.some((row: any) => row.detail?.strategyId === strategyId))
    assert.equal(sendMock.mock.calls.length, 1)
  })

  test('refuses an identity another account already holds for the same strategy', async (t) => {
    const { mail } = await import('./mail.ts')
    t.mock.method(mail, 'sendSignInMethodAdded', async () => {})
    const strategyId = freshStrategyId()
    await fixtures.db.insert(usersTable).values({
      email: `holder-${strategyId}@example.com`,
      name: 'Holder',
      isSystem: false,
      isActive: true,
      isVerified: true,
      auth: { [strategyId]: { id: 'taken-id', email: 'holder@example.com' } }
    })

    await assert.rejects(
      userCredentials.linkStrategy({
        userId: fixtures.userId,
        strategyId,
        identity: { id: 'taken-id', email: 'holder@example.com' },
        methodName: 'Provider'
      }),
      /ERR_LINK_IDENTITY_IN_USE/
    )
    const reloaded = (await usersModel.getById(fixtures.userId)) as any
    assert.equal(reloaded.auth[strategyId], undefined)
  })

  test('getByProviderLink finds the account by the stored provider id, not by address', async (t) => {
    const { mail } = await import('./mail.ts')
    t.mock.method(mail, 'sendSignInMethodAdded', async () => {})
    const strategyId = freshStrategyId()
    await userCredentials.linkStrategy({
      userId: fixtures.userId,
      strategyId,
      identity: { id: 'lookup-id', email: 'not-the-account-address@example.org' },
      methodName: 'Provider'
    })

    const found = await usersModel.getByProviderLink(strategyId, 'lookup-id')
    assert.equal(found?.id, fixtures.userId)
    assert.equal(await usersModel.getByProviderLink(strategyId, 'another-id'), null)
    assert.equal(await usersModel.getByProviderLink(freshStrategyId(), 'lookup-id'), null)
  })

  test('a later sign-in through the connected provider reaches the linked account, not the one owning its address', async (t) => {
    const { mail } = await import('./mail.ts')
    const { login } = await import('./login.ts')
    t.mock.method(mail, 'sendSignInMethodAdded', async () => {})
    const strategyId = freshStrategyId()
    const providerEmail = `work-${strategyId}@corp.example`
    await fixtures.db.insert(usersTable).values({
      email: providerEmail,
      name: 'Address Owner',
      isSystem: false,
      isActive: true,
      isVerified: true,
      auth: {}
    })
    await userCredentials.linkStrategy({
      userId: fixtures.userId,
      strategyId,
      identity: { id: 'round-trip-id', email: providerEmail },
      methodName: 'Provider'
    })

    const user = await (login as any).findOrCreateProviderUser(
      {
        id: strategyId,
        module: 'test-oidc',
        displayName: 'Provider',
        isEnabled: true,
        autoProvision: true,
        allowedEmailRegex: '',
        autoEnrollGroups: [],
        trustEmailForLinking: true,
        config: {}
      },
      { id: 'round-trip-id', email: providerEmail, name: 'Ada' }
    )

    assert.equal(user.id, fixtures.userId)
    const owner = await usersModel.getByEmail(providerEmail)
    assert.equal((owner!.auth as any)[strategyId], undefined)
  })
})
