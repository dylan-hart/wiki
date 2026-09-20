import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import bcrypt from 'bcryptjs'
import type { FastifyInstance } from 'fastify'
import { userCredentials } from '../../models/userCredentials.ts'
import usersRoutes from './index.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'

describe('profile sub-plugin: requireSessionUser', () => {
  let app: FastifyInstance

  before(async () => {
    app = await buildTestApp({
      routes: usersRoutes,
      prefix: '/users',
      session: 'header',
      permissions: true,
      ajv: true,
      wiki: { config: {} }
    })
  })

  after(() => closeTestApp(app))

  /** One per shape of profile route, not an exhaustive list. */
  const anonymous: Array<[string, string]> = [
    ['GET', '/users/profile'],
    ['GET', '/users/profile/groups'],
    ['GET', '/users/profile/api-keys'],
    ['GET', '/users/profile/editor-settings/markdown'],
    ['GET', '/users/profile/notifications'],
    ['GET', '/users/profile/auth'],
    ['GET', '/users/profile/tfa/recovery-codes?strategyId=00000000-0000-4000-8000-000000000000'],
    ['DELETE', '/users/profile/passkeys/11111111-1111-4111-8111-111111111111'],
    ['POST', '/users/profile/passkeys/challenge']
  ]

  for (const [method, url] of anonymous) {
    test(`${method} ${url} answers 401 Unauthorized with no session`, async () => {
      const res = await app.inject({ method: method as any, url })
      assert.equal(res.statusCode, 401)
      assert.deepEqual(res.json(), {
        ok: false,
        error: 'UnauthorizedError',
        statusCode: 401,
        message: 'Unauthorized'
      })
    })
  }

  test('validation still runs first: an anonymous request with a bad body answers 400, not 401', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/users/profile/password',
      payload: { strategyId: 'not-a-uuid', currentPassword: 'x', newPassword: 'yyyyyyyy' }
    })
    assert.equal(res.statusCode, 400)
    assert.match(res.json().message, /strategyId/)
  })

  test('the hook is scoped to this sub-plugin: an admin route still answers on its own permission gate', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/users/defaults',
      headers: { 'x-test-permissions': 'read:pages' }
    })
    // -> 403, not 401: a `requireSessionUser` leaked onto `admin.ts` would answer 401 here.
    assert.equal(res.statusCode, 403)
  })

  test('an anonymous request to an admin route is still 401, from its own permission gate', async () => {
    // -> Not a scoping proof on its own: the route-permission hook answers a session-less request
    //    with the same body `requireSessionUser` would. The 403 above is what tells the two apart.
    const res = await app.inject({ method: 'GET', url: '/users/defaults' })
    assert.equal(res.statusCode, 401)
  })
})

describe('profile passkeys: security.allowPasskeys', () => {
  const USER_ID = '11111111-1111-4111-8111-111111111111'
  const PASSKEY_ID = '22222222-2222-4222-8222-222222222222'
  const session = {
    'x-test-session': JSON.stringify({ authenticated: true, user: { id: USER_ID } })
  }
  const storedPasskeys = [{ id: PASSKEY_ID, name: 'Laptop' }]

  let app: FastifyInstance
  let startRegistration: ReturnType<typeof mock.fn>
  let finalizeRegistration: ReturnType<typeof mock.fn>
  let remove: ReturnType<typeof mock.fn>
  let list: ReturnType<typeof mock.fn>
  let security: Record<string, any>

  before(async () => {
    startRegistration = mock.fn(async () => ({
      registrationOptions: { challenge: 'c' },
      pending: 'p'
    }))
    finalizeRegistration = mock.fn(async () => ({ id: PASSKEY_ID, name: 'Laptop' }))
    remove = mock.fn(async () => true)
    list = mock.fn(async () => storedPasskeys)
    security = {}
    app = await buildTestApp({
      routes: usersRoutes,
      prefix: '/users',
      session: 'header',
      permissions: true,
      ajv: true,
      wiki: {
        config: { security },
        models: {
          passkeys: { startRegistration, finalizeRegistration, remove, list },
          userCredentials: { getProfileAuthMethods: async () => [] }
        }
      }
    })
  })

  after(() => closeTestApp(app))

  beforeEach(() => {
    for (const fn of [startRegistration, finalizeRegistration, remove, list]) {
      fn.mock.resetCalls()
    }
  })

  const registerBody = { name: 'Laptop', registrationResponse: { id: 'x' } }

  for (const allowPasskeys of [true, undefined]) {
    test(`registration proceeds when allowPasskeys is ${allowPasskeys ?? 'absent'}`, async () => {
      security.allowPasskeys = allowPasskeys
      const challenge = await app.inject({
        method: 'POST',
        url: '/users/profile/passkeys/challenge',
        headers: session
      })
      assert.equal(challenge.statusCode, 200)
      const register = await app.inject({
        method: 'POST',
        url: '/users/profile/passkeys',
        headers: session,
        payload: registerBody
      })
      assert.equal(register.statusCode, 200)
      const auth = await app.inject({ method: 'GET', url: '/users/profile/auth', headers: session })
      assert.equal(auth.json().passkeysEnabled, true)
    })
  }

  test('off refuses both registration endpoints with ERR_PASSKEYS_DISABLED before touching the model', async () => {
    security.allowPasskeys = false
    const challenge = await app.inject({
      method: 'POST',
      url: '/users/profile/passkeys/challenge',
      headers: session
    })
    assert.equal(challenge.statusCode, 400)
    assert.equal(challenge.json().message, 'ERR_PASSKEYS_DISABLED')
    const register = await app.inject({
      method: 'POST',
      url: '/users/profile/passkeys',
      headers: session,
      payload: registerBody
    })
    assert.equal(register.statusCode, 400)
    assert.equal(register.json().message, 'ERR_PASSKEYS_DISABLED')
    assert.equal(startRegistration.mock.calls.length, 0)
    assert.equal(finalizeRegistration.mock.calls.length, 0)
  })

  test('off keeps stored passkeys listed, reports passkeysEnabled false, and still allows removal', async () => {
    security.allowPasskeys = false
    const auth = await app.inject({ method: 'GET', url: '/users/profile/auth', headers: session })
    assert.equal(auth.statusCode, 200)
    assert.equal(auth.json().passkeysEnabled, false)
    assert.equal(auth.json().passkeys.length, 1)

    const del = await app.inject({
      method: 'DELETE',
      url: `/users/profile/passkeys/${PASSKEY_ID}`,
      headers: session
    })
    assert.equal(del.statusCode, 204)
    assert.equal(remove.mock.calls.length, 1)
  })
})

describe('profile password change and allowPasswordChange', () => {
  let app: FastifyInstance
  let strategyConfig: Record<string, any> | null
  let patchMock: ReturnType<typeof mock.fn>

  const USER_ID = '11111111-1111-4111-8111-111111111111'
  const STRATEGY_ID = '22222222-2222-4222-8222-222222222222'
  const CURRENT_PASSWORD = 'current-password'
  const SESSION = {
    'x-test-session': JSON.stringify({ authenticated: true, user: { id: USER_ID } })
  }

  before(async () => {
    const passwordHash = await bcrypt.hash(CURRENT_PASSWORD, 4)
    const user = { id: USER_ID, auth: { [STRATEGY_ID]: { password: passwordHash } } }
    patchMock = mock.method(userCredentials, 'patchStrategyAuth', async () => true)
    app = await buildTestApp({
      routes: usersRoutes,
      prefix: '/users',
      session: 'header',
      ajv: true,
      swagger: true,
      wiki: {
        config: {},
        data: { authentication: [{ key: 'local', title: 'Local', icon: '', props: {} }] },
        db: {
          select: () => ({
            from: async () => [
              { id: STRATEGY_ID, module: 'local', displayName: 'Local', config: strategyConfig }
            ]
          })
        },
        models: {
          users: { getById: async () => user },
          userCredentials,
          passkeys: { list: async () => [] },
          authentication: {
            getStrategyById: async () =>
              strategyConfig === null ? null : { id: STRATEGY_ID, config: strategyConfig }
          },
          flags: { authDebug: () => {} }
        }
      }
    })
  })

  after(async () => {
    mock.restoreAll()
    await closeTestApp(app)
  })

  function changePassword() {
    return app.inject({
      method: 'PUT',
      url: '/users/profile/password',
      headers: SESSION,
      payload: {
        strategyId: STRATEGY_ID,
        currentPassword: CURRENT_PASSWORD,
        newPassword: 'a-brand-new-password'
      }
    })
  }

  test('allowPasswordChange off refuses with ERR_PASSWORD_CHANGE_DISABLED and writes nothing', async () => {
    strategyConfig = { allowPasswordChange: false }
    patchMock.mock.resetCalls()
    const res = await changePassword()
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().message, 'ERR_PASSWORD_CHANGE_DISABLED')
    assert.equal(patchMock.mock.callCount(), 0)
  })

  test('allowPasswordChange on changes the password', async () => {
    strategyConfig = { allowPasswordChange: true }
    patchMock.mock.resetCalls()
    const res = await changePassword()
    assert.equal(res.statusCode, 200)
    assert.equal(patchMock.mock.callCount(), 1)
  })

  test('a strategy config saved before the prop existed still allows the change', async () => {
    strategyConfig = {}
    patchMock.mock.resetCalls()
    const res = await changePassword()
    assert.equal(res.statusCode, 200)
    assert.equal(patchMock.mock.callCount(), 1)
  })

  test('a strategy that cannot be found still allows the change', async () => {
    strategyConfig = null
    patchMock.mock.resetCalls()
    const res = await changePassword()
    assert.equal(res.statusCode, 200)
  })

  test('the profile providers report canChangePassword: false when it is off', async () => {
    strategyConfig = { allowPasswordChange: false }
    const res = await app.inject({ method: 'GET', url: '/users/profile/auth', headers: SESSION })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().authMethods[0].config.canChangePassword, false)
  })

  test('the profile providers report canChangePassword: true when it is on or absent', async () => {
    for (const config of [{ allowPasswordChange: true }, {}]) {
      strategyConfig = config
      const res = await app.inject({ method: 'GET', url: '/users/profile/auth', headers: SESSION })
      assert.equal(res.json().authMethods[0].config.canChangePassword, true)
    }
  })
})
