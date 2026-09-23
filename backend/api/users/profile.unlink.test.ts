import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import usersRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const STRATEGY_ID = '22222222-2222-4222-8222-222222222222'
const SESSION = {
  'x-test-session': JSON.stringify({
    authenticated: true,
    user: { id: USER_ID, name: 'Ada', email: 'ada@example.com' }
  })
}

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
