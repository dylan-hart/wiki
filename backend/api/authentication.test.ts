import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import authenticationRoutes from './authentication.ts'
import { registerSchemas as registerAuthenticationSchema } from './schemas/authentication.ts'

/**
 * `POST /sites/:siteId/auth/register` and `GET /auth/verify/:token` — the request/response wiring
 * around `WIKI.models.users.register()` / `validateToken()` / `updateUser()`, which are stubbed here
 * rather than run for real (that's `models/users.test.ts`'s DB-backed coverage of `register()` itself).
 * Registers the whole `authentication.ts` plugin, matching `api/mail.test.ts`'s pattern, since Fastify
 * compiles every route's schema at `ready()` regardless of which ones a given test actually hits.
 */

let app: FastifyInstance
let registerMock: ReturnType<typeof mock.fn>
let validateTokenMock: ReturnType<typeof mock.fn>
let updateUserMock: ReturnType<typeof mock.fn>
let forgotPasswordMock: ReturnType<typeof mock.fn>
let resetPasswordMock: ReturnType<typeof mock.fn>

before(async () => {
  ;(globalThis as any).WIKI = {
    models: {
      users: {
        register: (...args: any[]) => registerMock(...args),
        validateToken: (...args: any[]) => validateTokenMock(...args),
        updateUser: (...args: any[]) => updateUserMock(...args),
        forgotPassword: (...args: any[]) => forgotPasswordMock(...args),
        resetPassword: (...args: any[]) => resetPasswordMock(...args)
      },
      flags: {
        authDebug: () => {}
      },
      rateLimits: {
        consume: async () => ({ allowed: true, retryAfter: 0 })
      },
      hooks: {
        emit: async () => 0
      }
    },
    config: {},
    logger: {
      warn: mock.fn(),
      error: mock.fn(),
      info: mock.fn(),
      debug: mock.fn()
    }
  }

  app = fastify()
  await app.register(fastifySensible)
  // -> Stand-in for `@fastify/session` (registered app-wide in `index.ts`, not here): the
  //    resetPassword route writes `req.session.authenticated` on success the same way
  //    `changePassword` does, so `req.session` needs to be a real mutable object per request.
  app.decorateRequest('session', null as any)
  app.addHook('onRequest', async (req) => {
    req.session = {} as any
  })
  await registerAuthenticationSchema(app)
  await app.register(authenticationRoutes)
  await app.ready()
})

after(async () => {
  await app.close()
  delete (globalThis as any).WIKI
})

beforeEach(() => {
  registerMock = mock.fn(async () => ({ nextAction: 'verify' }))
  validateTokenMock = mock.fn(async () => ({ user: { id: 'user-1', email: 'ada@example.com' } }))
  updateUserMock = mock.fn(async () => true)
  forgotPasswordMock = mock.fn(async () => {})
  resetPasswordMock = mock.fn(async () => ({
    authenticated: true,
    nextAction: 'redirect',
    redirect: '/'
  }))
})

function registerPayload(overrides: Record<string, any> = {}) {
  return {
    strategyId: '11111111-1111-1111-1111-111111111111',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    password: 'longenough1',
    ...overrides
  }
}

test('POST register: passes the body through and reports a pending verification', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/sites/22222222-2222-2222-2222-222222222222/auth/register',
    payload: registerPayload()
  })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), { ok: true, nextAction: 'verify' })
  assert.equal(registerMock.mock.calls.length, 1)
  const arg = registerMock.mock.calls[0].arguments[0] as any
  assert.equal(arg.siteId, '22222222-2222-2222-2222-222222222222')
  assert.equal(arg.strategyId, '11111111-1111-1111-1111-111111111111')
  assert.equal(arg.name, 'Ada Lovelace')
  assert.equal(arg.email, 'ada@example.com')
  assert.equal(arg.password, 'longenough1')
})

test('POST register: an emailValidation-off strategy logs straight in', async () => {
  registerMock = mock.fn(async () => ({
    authenticated: true,
    nextAction: 'redirect',
    redirect: '/'
  }))

  const res = await app.inject({
    method: 'POST',
    url: '/sites/22222222-2222-2222-2222-222222222222/auth/register',
    payload: registerPayload()
  })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), {
    ok: true,
    authenticated: true,
    nextAction: 'redirect',
    redirect: '/'
  })
})

test('POST register: rejects a short password before calling the model', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/sites/22222222-2222-2222-2222-222222222222/auth/register',
    payload: registerPayload({ password: 'short' })
  })

  assert.equal(res.statusCode, 400)
  assert.equal(registerMock.mock.calls.length, 0)
})

test('POST register: an ERR_ failure from the model becomes a 400 with that code', async () => {
  registerMock = mock.fn(async () => {
    throw new Error('ERR_EMAIL_ALREADY_EXISTS')
  })

  const res = await app.inject({
    method: 'POST',
    url: '/sites/22222222-2222-2222-2222-222222222222/auth/register',
    payload: registerPayload()
  })

  assert.equal(res.statusCode, 400)
  assert.equal(res.json().message, 'ERR_EMAIL_ALREADY_EXISTS')
})

test('POST register: an unexpected failure becomes a generic 400, logged rather than leaked', async () => {
  registerMock = mock.fn(async () => {
    throw new Error('connection refused')
  })

  const res = await app.inject({
    method: 'POST',
    url: '/sites/22222222-2222-2222-2222-222222222222/auth/register',
    payload: registerPayload()
  })

  assert.equal(res.statusCode, 400)
  assert.equal(res.json().message, 'ERR_REGISTRATION_FAILED')
})

test('GET verify: marks the account verified and redirects to the login screen', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/auth/verify/some-token'
  })

  assert.equal(res.statusCode, 302)
  assert.equal(res.headers.location, '/login?verified=true')
  assert.equal(validateTokenMock.mock.calls.length, 1)
  assert.deepEqual(validateTokenMock.mock.calls[0].arguments[0], {
    kind: 'verify',
    token: 'some-token'
  })
  assert.equal(updateUserMock.mock.calls.length, 1)
  assert.deepEqual(updateUserMock.mock.calls[0].arguments, ['user-1', { isVerified: true }])
})

test('GET verify: an invalid token redirects to the login screen with an error code', async () => {
  validateTokenMock = mock.fn(async () => {
    throw new Error('ERR_INVALID_VALIDATION_TOKEN')
  })

  const res = await app.inject({
    method: 'GET',
    url: '/auth/verify/bad-token'
  })

  assert.equal(res.statusCode, 302)
  assert.equal(res.headers.location, '/login?error=ERR_INVALID_VALIDATION_TOKEN')
  assert.equal(updateUserMock.mock.calls.length, 0)
})

test('GET verify: an expired token redirects to the login screen with an error code', async () => {
  validateTokenMock = mock.fn(async () => {
    throw new Error('ERR_EXPIRED_VALIDATION_TOKEN')
  })

  const res = await app.inject({
    method: 'GET',
    url: '/auth/verify/expired-token'
  })

  assert.equal(res.statusCode, 302)
  assert.equal(res.headers.location, '/login?error=ERR_EXPIRED_VALIDATION_TOKEN')
  assert.equal(updateUserMock.mock.calls.length, 0)
})

/**
 * `POST /sites/:siteId/auth/forgotPassword` -- the one thing to prove at the route layer is that the
 * generic success response is truly unconditional: it must come back identical whether the model sent
 * an email or silently did nothing, and even when the model throws outright. Which of those happened
 * is `models/users.test.ts`'s `forgotPassword()` coverage; this file only owns the request/response
 * wiring, per this file's own header comment.
 */
test('POST forgotPassword: passes the body through and reports the generic success', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/sites/22222222-2222-2222-2222-222222222222/auth/forgotPassword',
    payload: { strategyId: '11111111-1111-1111-1111-111111111111', email: 'ada@example.com' }
  })

  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(typeof body.message, 'string')
  assert.equal(forgotPasswordMock.mock.calls.length, 1)
  assert.deepEqual(forgotPasswordMock.mock.calls[0].arguments[0], {
    strategyId: '11111111-1111-1111-1111-111111111111',
    email: 'ada@example.com'
  })
})

test('POST forgotPassword: an address the model silently ignores gets the exact same response', async () => {
  const resSent = await app.inject({
    method: 'POST',
    url: '/sites/22222222-2222-2222-2222-222222222222/auth/forgotPassword',
    payload: {
      strategyId: '11111111-1111-1111-1111-111111111111',
      email: 'has-account@example.com'
    }
  })

  forgotPasswordMock = mock.fn(async () => {})
  const resNotSent = await app.inject({
    method: 'POST',
    url: '/sites/22222222-2222-2222-2222-222222222222/auth/forgotPassword',
    payload: {
      strategyId: '11111111-1111-1111-1111-111111111111',
      email: 'no-such-account@example.com'
    }
  })

  assert.equal(resSent.statusCode, resNotSent.statusCode)
  assert.deepEqual(resSent.json(), resNotSent.json())
})

test('POST forgotPassword: even an unexpected model failure still gets the generic success, not an error', async () => {
  forgotPasswordMock = mock.fn(async () => {
    throw new Error('connection refused')
  })

  const res = await app.inject({
    method: 'POST',
    url: '/sites/22222222-2222-2222-2222-222222222222/auth/forgotPassword',
    payload: { strategyId: '11111111-1111-1111-1111-111111111111', email: 'ada@example.com' }
  })

  assert.equal(res.statusCode, 200)
  assert.equal(res.json().ok, true)
})

test('PUT resetPassword: passes the body through and logs the account straight in on success', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: '/sites/22222222-2222-2222-2222-222222222222/auth/resetPassword',
    payload: {
      strategyId: '11111111-1111-1111-1111-111111111111',
      token: 'reset-token',
      newPassword: 'brandnewpwd1'
    }
  })

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json(), {
    ok: true,
    authenticated: true,
    nextAction: 'redirect',
    redirect: '/'
  })
  assert.equal(resetPasswordMock.mock.calls.length, 1)
  const arg = resetPasswordMock.mock.calls[0].arguments[0] as any
  assert.equal(arg.siteId, '22222222-2222-2222-2222-222222222222')
  assert.equal(arg.strategyId, '11111111-1111-1111-1111-111111111111')
  assert.equal(arg.token, 'reset-token')
  assert.equal(arg.newPassword, 'brandnewpwd1')
})

test('PUT resetPassword: an account with 2FA active answers provideTfa rather than logging in', async () => {
  resetPasswordMock = mock.fn(async () => ({
    nextAction: 'provideTfa',
    continuationToken: 'tfa-token',
    redirect: '/'
  }))

  const res = await app.inject({
    method: 'PUT',
    url: '/sites/22222222-2222-2222-2222-222222222222/auth/resetPassword',
    payload: {
      strategyId: '11111111-1111-1111-1111-111111111111',
      token: 'reset-token',
      newPassword: 'brandnewpwd1'
    }
  })

  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.nextAction, 'provideTfa')
  assert.equal(body.continuationToken, 'tfa-token')
  assert.equal(body.authenticated, undefined)
})

test('PUT resetPassword: rejects a short password before calling the model', async () => {
  const res = await app.inject({
    method: 'PUT',
    url: '/sites/22222222-2222-2222-2222-222222222222/auth/resetPassword',
    payload: {
      strategyId: '11111111-1111-1111-1111-111111111111',
      token: 'reset-token',
      newPassword: 'short'
    }
  })

  assert.equal(res.statusCode, 400)
  assert.equal(resetPasswordMock.mock.calls.length, 0)
})

test('PUT resetPassword: an ERR_ failure from the model becomes a 400 with that code', async () => {
  resetPasswordMock = mock.fn(async () => {
    throw new Error('ERR_INVALID_VALIDATION_TOKEN')
  })

  const res = await app.inject({
    method: 'PUT',
    url: '/sites/22222222-2222-2222-2222-222222222222/auth/resetPassword',
    payload: {
      strategyId: '11111111-1111-1111-1111-111111111111',
      token: 'bad-token',
      newPassword: 'brandnewpwd1'
    }
  })

  assert.equal(res.statusCode, 400)
  assert.equal(res.json().message, 'ERR_INVALID_VALIDATION_TOKEN')
})

test('PUT resetPassword: an unexpected failure becomes a generic 400, logged rather than leaked', async () => {
  resetPasswordMock = mock.fn(async () => {
    throw new Error('connection refused')
  })

  const res = await app.inject({
    method: 'PUT',
    url: '/sites/22222222-2222-2222-2222-222222222222/auth/resetPassword',
    payload: {
      strategyId: '11111111-1111-1111-1111-111111111111',
      token: 'reset-token',
      newPassword: 'brandnewpwd1'
    }
  })

  assert.equal(res.statusCode, 400)
  assert.equal(res.json().message, 'ERR_RESET_PASSWORD_FAILED')
})
