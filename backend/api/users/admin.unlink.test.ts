import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import usersRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

const ADMIN_ID = '11111111-1111-4111-8111-111111111111'
const TARGET_ID = '33333333-3333-4333-8333-333333333333'
const MISSING_ID = '44444444-4444-4444-8444-444444444444'
const STRATEGY_ID = '22222222-2222-4222-8222-222222222222'

function sessionHeaders(permissions: string[]): Record<string, string> {
  return {
    'x-test-session': JSON.stringify({
      authenticated: true,
      user: { id: ADMIN_ID, name: 'Admin', email: 'admin@example.com' },
      permissions,
      groups: []
    })
  }
}

describe('DELETE /users/:userId/auth/:strategyId', () => {
  let app: FastifyInstance
  let unlinkStrategy: ReturnType<typeof mock.fn>
  let unlinkError: Error | null
  let targetIsSystem: boolean

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
          users: {
            getById: async (id: string) =>
              id === TARGET_ID ? { id, email: 'target@example.com', name: 'Target' } : null
          },
          userCredentials: { unlinkStrategy },
          groups: {
            holdsSystemPermission: (req: any) =>
              (req.session?.permissions ?? []).includes('manage:system'),
            userHoldsSystemPermission: async () => targetIsSystem
          }
        }
      }
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    unlinkError = null
    targetIsSystem = false
    unlinkStrategy.mock.resetCalls()
  })

  function disconnect(headers: Record<string, string>, userId = TARGET_ID) {
    return app.inject({
      method: 'DELETE',
      url: `/users/${userId}/auth/${STRATEGY_ID}`,
      headers
    })
  }

  test('answers 401 with no session', async () => {
    const res = await disconnect({})
    assert.equal(res.statusCode, 401)
    assert.equal(unlinkStrategy.mock.callCount(), 0)
  })

  test('refuses a caller without manage:users with 403', async () => {
    const res = await disconnect(sessionHeaders(['read:users']))
    assert.equal(res.statusCode, 403)
    assert.equal(unlinkStrategy.mock.callCount(), 0)
  })

  test('answers 404 for a user that does not exist', async () => {
    const res = await disconnect(sessionHeaders(['manage:users']), MISSING_ID)
    assert.equal(res.statusCode, 404)
    assert.equal(unlinkStrategy.mock.callCount(), 0)
  })

  test('refuses to touch a manage:system account for a caller who lacks manage:system', async () => {
    targetIsSystem = true
    const res = await disconnect(sessionHeaders(['manage:users']))
    assert.equal(res.statusCode, 403)
    assert.equal(unlinkStrategy.mock.callCount(), 0)
  })

  test('disconnects the target user, recording the administrator as actor, and answers 204', async () => {
    const res = await disconnect(sessionHeaders(['manage:users']))
    assert.equal(res.statusCode, 204)
    assert.equal(unlinkStrategy.mock.callCount(), 1)
    const args = unlinkStrategy.mock.calls[0]!.arguments[0] as any
    assert.equal(args.userId, TARGET_ID)
    assert.equal(args.strategyId, STRATEGY_ID)
    assert.equal(args.actor.id, ADMIN_ID)
    assert.equal(args.actor.email, 'admin@example.com')
  })

  for (const code of [
    'ERR_UNLINK_LOCAL_STRATEGY',
    'ERR_UNLINK_NOT_LINKED',
    'ERR_UNLINK_LAST_LOGIN_METHOD'
  ]) {
    test(`answers 400 ${code} when the model refuses`, async () => {
      unlinkError = new Error(code)
      const res = await disconnect(sessionHeaders(['manage:users']))
      assert.equal(res.statusCode, 400)
      assert.equal(res.json().message, code)
    })
  }
})
