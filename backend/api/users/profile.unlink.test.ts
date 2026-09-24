import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import usersRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb } from '../../test/db.ts'
import { ensureTemporal } from '../../test/temporal.ts'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const STRATEGY_ID = '22222222-2222-4222-8222-222222222222'
const SESSION = {
  'x-test-session': JSON.stringify({
    authenticated: true,
    user: { id: USER_ID, name: 'Ada', email: 'ada@example.com' }
  })
}

const LOCAL_ID = '10000000-0000-4000-8000-000000000001'

before(async () => {
  if (!hasTestDatabase()) {
    return
  }
  await setupTestDb()
})

after(async () => {
  if (!hasTestDatabase()) {
    return
  }
  await teardownTestDb()
})

describe('DELETE /users/profile/auth/:strategyId', () => {
  let app: FastifyInstance
  let unlinkStrategy: ReturnType<typeof mock.fn>
  let unlinkError: Error | null

  before(async () => {
    unlinkStrategy = mock.fn(async () => {
      if (unlinkError) {
        throw unlinkError
      }
    })
    app = await buildTestApp({
      routes: usersRoutes,
      prefix: '/users',
      session: 'header',
      permissions: true,
      ajv: true,
      wiki: {
        config: {},
        models: {
          userCredentials: {
            unlinkStrategy,
            getProfileAuthMethods: async () => [
              {
                authId: STRATEGY_ID,
                authName: 'Okta',
                strategyKey: 'oidc',
                strategyIcon: '',
                config: {
                  isPasswordSet: false,
                  isTfaSetup: false,
                  isTfaRequired: false,
                  isPasswordLoginEnabled: true,
                  canChangePassword: true,
                  canDisablePasswordLogin: true,
                  canDisconnect: true,
                  recoveryCodesRemaining: 0
                }
              }
            ]
          },
          passkeys: { list: async () => [] }
        }
      }
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    unlinkError = null
    unlinkStrategy.mock.resetCalls()
  })

  function disconnect(headers: Record<string, string> = SESSION, strategyId = STRATEGY_ID) {
    return app.inject({ method: 'DELETE', url: `/users/profile/auth/${strategyId}`, headers })
  }

  test('answers 401 with no session, without touching the account', async () => {
    const res = await disconnect({})
    assert.equal(res.statusCode, 401)
    assert.equal(unlinkStrategy.mock.callCount(), 0)
  })

  test('answers 400 for a strategy id that is not a uuid', async () => {
    const res = await disconnect(SESSION, 'not-a-uuid')
    assert.equal(res.statusCode, 400)
    assert.equal(unlinkStrategy.mock.callCount(), 0)
  })

  test('disconnects from the session user own account and answers 204', async () => {
    const res = await disconnect()
    assert.equal(res.statusCode, 204)
    assert.equal(res.body, '')
    assert.equal(unlinkStrategy.mock.callCount(), 1)
    const args = unlinkStrategy.mock.calls[0]!.arguments[0] as any
    assert.equal(args.userId, USER_ID)
    assert.equal(args.strategyId, STRATEGY_ID)
    assert.equal(args.actor.id, USER_ID)
    assert.equal(args.actor.email, 'ada@example.com')
  })

  for (const code of [
    'ERR_UNLINK_LOCAL_STRATEGY',
    'ERR_UNLINK_NOT_LINKED',
    'ERR_UNLINK_LAST_LOGIN_METHOD'
  ]) {
    test(`answers 400 ${code} when the model refuses`, async () => {
      unlinkError = new Error(code)
      const res = await disconnect()
      assert.equal(res.statusCode, 400)
      assert.equal(res.json().message, code)
    })
  }

  test('GET /users/profile/auth keeps canDisconnect in the response', async () => {
    const res = await app.inject({ method: 'GET', url: '/users/profile/auth', headers: SESSION })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().authMethods[0].config.canDisconnect, true)
  })
})

describe('DELETE /users/profile/auth/:strategyId (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let app: FastifyInstance

  before(async () => {
    await ensureTemporal()
    CARDINAL.data.systemIds = { ...CARDINAL.data.systemIds, localAuthId: LOCAL_ID } as any
    // -> Both enabled and loaded: only a working strategy counts as a way in
    CARDINAL.auth.strategies = { [LOCAL_ID]: {}, [STRATEGY_ID]: {} } as any
    mock.method(CARDINAL.models.mail, 'sendSignInMethodRemoved', async () => {})
    app = await buildTestApp({
      routes: usersRoutes,
      prefix: '/users',
      session: 'header',
      permissions: true,
      ajv: true
    })
  })

  after(async () => {
    mock.restoreAll()
    await closeTestApp(app)
  })

  function sessionOf(userId: string): Record<string, string> {
    return {
      'x-test-session': JSON.stringify({
        authenticated: true,
        user: { id: userId, name: 'Account Holder', email: 'holder@example.com' }
      })
    }
  }

  async function provisionedBySso(): Promise<string> {
    const user = await (CARDINAL.models.login as any).findOrCreateProviderUser(
      {
        id: STRATEGY_ID,
        module: 'test-oidc',
        displayName: 'Okta',
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

  test('refuses to disconnect the only provider of an account it provisioned', async () => {
    const userId = await provisionedBySso()

    const profile = await app.inject({
      method: 'GET',
      url: '/users/profile/auth',
      headers: sessionOf(userId)
    })
    const provider = profile.json().authMethods.find((m: any) => m.authId === STRATEGY_ID)
    assert.equal(provider.config.canDisconnect, false)

    const res = await app.inject({
      method: 'DELETE',
      url: `/users/profile/auth/${STRATEGY_ID}`,
      headers: sessionOf(userId)
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().message, 'ERR_UNLINK_LAST_LOGIN_METHOD')
    const user = await CARDINAL.models.users.getById(userId)
    assert.ok((user!.auth as Record<string, any>)[STRATEGY_ID])
  })

  test('disconnects a provider from an account whose password its holder knows', async () => {
    const userId = await CARDINAL.models.users.createUser({
      name: 'Registered User',
      email: `registered-${Math.random().toString(36).slice(2)}@example.com`,
      password: 'chosenpwd1'
    })
    await CARDINAL.models.userCredentials.patchStrategyAuth(userId, STRATEGY_ID, () => ({
      id: 'linked-provider'
    }))

    const res = await app.inject({
      method: 'DELETE',
      url: `/users/profile/auth/${STRATEGY_ID}`,
      headers: sessionOf(userId)
    })
    assert.equal(res.statusCode, 204)
    const user = await CARDINAL.models.users.getById(userId)
    assert.equal((user!.auth as Record<string, any>)[STRATEGY_ID], undefined)
  })
})
