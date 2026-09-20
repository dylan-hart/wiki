import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fastifyCookie from '@fastify/cookie'
import authenticationRoutes from './index.ts'
import { AccountRateLimitedError } from '../../helpers/rateLimit.ts'
import { siteEnabledPreHandler, SITE_MISSING_MESSAGE } from '../../helpers/siteResolution.ts'
import { SESSION_COOKIE_NAME, SESSION_COOKIE_NAME_INSECURE } from '../../helpers/security.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'
import { installTestWiki } from '../../test/mocks.ts'

let wikiHandle: { restore(): void }

/** The logout route's `clearCookie` needs a cookie parser. */
const withCookies: FastifyPluginAsync = async (instance) => {
  await instance.register(fastifyCookie)
  await instance.register(authenticationRoutes)
}

const withSiteGuard: FastifyPluginAsync = async (instance) => {
  instance.addHook('preHandler', siteEnabledPreHandler)
  await instance.register(authenticationRoutes)
}

describe('local account lifecycle (register/verify/forgotPassword/resetPassword)', () => {
  let app: FastifyInstance
  let registerMock: ReturnType<typeof mock.fn>
  let validateTokenMock: ReturnType<typeof mock.fn>
  let updateUserMock: ReturnType<typeof mock.fn>
  let forgotPasswordMock: ReturnType<typeof mock.fn>
  let resetPasswordMock: ReturnType<typeof mock.fn>

  before(async () => {
    wikiHandle = installTestWiki({
      models: {
        users: {
          updateUser: (...args: any[]) => updateUserMock(...args)
        },
        login: {
          register: (...args: any[]) => registerMock(...args),
          forgotPassword: (...args: any[]) => forgotPasswordMock(...args),
          resetPassword: (...args: any[]) => resetPasswordMock(...args)
        },
        userCredentials: {
          validateToken: (...args: any[]) => validateTokenMock(...args)
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
    })

    app = await buildTestApp({
      routes: authenticationRoutes,
      // -> A mutable per-request object: resetPassword writes `req.session.authenticated`
      session: () => ({})
    })
  })

  after(async () => {
    await closeTestApp(app)
    wikiHandle.restore()
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

  // -> The route derives no display name; `models/users.ts#resolveNameFields` does
  test('POST register: carries firstName/lastName through with no name at all', async () => {
    const { name: _name, ...halves } = registerPayload()
    const res = await app.inject({
      method: 'POST',
      url: '/sites/22222222-2222-2222-2222-222222222222/auth/register',
      payload: { ...halves, firstName: 'Ada', lastName: 'Lovelace' }
    })

    assert.equal(res.statusCode, 200)
    const arg = registerMock.mock.calls[0].arguments[0] as any
    assert.equal(arg.firstName, 'Ada')
    assert.equal(arg.lastName, 'Lovelace')
    assert.equal(arg.name, undefined)
  })

  test('POST register: a mononym registers with an empty last name, no surname invented', async () => {
    const { name: _name, ...halves } = registerPayload()
    const res = await app.inject({
      method: 'POST',
      url: '/sites/22222222-2222-2222-2222-222222222222/auth/register',
      payload: { ...halves, firstName: 'Prince', lastName: '' }
    })

    assert.equal(res.statusCode, 200)
    const arg = registerMock.mock.calls[0].arguments[0] as any
    assert.equal(arg.firstName, 'Prince')
    assert.equal(arg.lastName, '')
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
   * The generic success must be unconditional -- identical whether the model sent an email, did
   * nothing or threw -- or the route reveals which addresses have accounts.
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
      email: 'ada@example.com',
      // -> So the mailed link can point at the requesting site's own hostname
      siteId: '22222222-2222-2222-2222-222222222222',
      ip: '127.0.0.1'
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
})

/**
 * The `__Host-` prefix requires `Secure; Path=/` on every `Set-Cookie` for that name, a clearing
 * one included, or the browser rejects it and keeps the stale session cookie.
 */
describe('POST /sites/:siteId/auth/logout — clearCookie attributes', () => {
  let app: FastifyInstance
  let destroyMock: ReturnType<typeof mock.fn>

  async function buildApp(cookieSecure: boolean) {
    wikiHandle = installTestWiki({
      config: { security: { cookieSecure } },
      models: {
        flags: { authDebug: () => {} },
        login: {
          getLogoutRedirect: async () => '/'
        },
        hooks: {
          emit: async () => 0
        }
      }
    })

    const built = await buildTestApp({
      routes: withCookies,
      session: () => ({ authenticated: false, destroy: destroyMock })
    })
    return built
  }

  beforeEach(() => {
    destroyMock = mock.fn(async () => {})
  })

  after(async () => {
    await closeTestApp(app)
    wikiHandle.restore()
  })

  test('secure deployment (default): Set-Cookie clears the __Host- cookie with Path=/, Secure, SameSite=Lax', async () => {
    app = await buildApp(true)

    const res = await app.inject({
      method: 'POST',
      url: '/sites/11111111-1111-1111-1111-111111111111/auth/logout'
    })

    assert.equal(res.statusCode, 200)
    const setCookie = res.headers['set-cookie']
    assert.ok(setCookie, 'expected a Set-Cookie header clearing the session cookie')
    const header = Array.isArray(setCookie) ? setCookie.join('\n') : String(setCookie)
    assert.ok(header.includes(`${SESSION_COOKIE_NAME}=`), 'clears the __Host- cookie by name')
    assert.match(header, /Path=\//)
    assert.match(header, /Secure/)
    assert.match(header, /SameSite=Lax/i)
  })

  test('security.cookieSecure: false — clears the insecure cookie name, still SameSite=Lax, no Secure', async () => {
    app = await buildApp(false)

    const res = await app.inject({
      method: 'POST',
      url: '/sites/11111111-1111-1111-1111-111111111111/auth/logout'
    })

    assert.equal(res.statusCode, 200)
    const setCookie = res.headers['set-cookie']
    assert.ok(setCookie, 'expected a Set-Cookie header clearing the session cookie')
    const header = Array.isArray(setCookie) ? setCookie.join('\n') : String(setCookie)
    assert.ok(
      header.includes(`${SESSION_COOKIE_NAME_INSECURE}=`),
      'clears the plain cookie by name'
    )
    assert.match(header, /Path=\//)
    assert.match(header, /SameSite=Lax/i)
    assert.ok(!header.includes('Secure'), 'plain-HTTP mode must not mark the cookie Secure')
  })
})

describe('POST /sites/:siteId/auth/logout — audit log', () => {
  let app: FastifyInstance
  let record: ReturnType<typeof mock.fn>

  async function buildApp(session: Record<string, any>) {
    record = mock.fn(async () => {})
    wikiHandle = installTestWiki({
      config: { security: { cookieSecure: true } },
      models: {
        flags: { authDebug: () => {} },
        login: { getLogoutRedirect: async () => '/' },
        hooks: { emit: async () => 0 },
        auditLog: { record }
      }
    })
    return buildTestApp({
      routes: withCookies,
      session: () => ({ ...session, destroy: async () => {} })
    })
  }

  after(async () => {
    await closeTestApp(app)
    wikiHandle.restore()
  })

  test('a logged-in session records user.loggedOut for the account, with its email snapshot', async () => {
    app = await buildApp({
      authenticated: true,
      user: { id: 'user-1', name: 'Ada Lovelace', email: 'ada@example.com' }
    })

    const res = await app.inject({
      method: 'POST',
      url: '/sites/11111111-1111-1111-1111-111111111111/auth/logout'
    })

    assert.equal(res.statusCode, 200)
    assert.equal(record.mock.calls.length, 1)
    const entry = record.mock.calls[0]!.arguments[0] as any
    assert.equal(entry.event, 'user.loggedOut')
    assert.deepEqual(entry.actor, {
      id: 'user-1',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      ip: '127.0.0.1'
    })
    assert.equal(entry.targetId, 'user-1')
  })

  test('a request with no session records nothing', async () => {
    await closeTestApp(app)
    wikiHandle.restore()
    app = await buildApp({ authenticated: false })

    const res = await app.inject({
      method: 'POST',
      url: '/sites/11111111-1111-1111-1111-111111111111/auth/logout'
    })

    assert.equal(res.statusCode, 200)
    assert.equal(record.mock.calls.length, 0)
  })
})

/**
 * The route is public, so it publishes only what the login screen can act on: `selfRegistration`
 * for a form-based strategy, and nothing about a redirect-based provider's `autoProvision`.
 */
describe('GET /sites/:siteId/auth/strategies', () => {
  const SITE_ID = 'b1111111-1111-1111-1111-111111111111'
  const LOCAL_STRATEGY_ID = 'b2222222-2222-2222-2222-222222222222'
  const SAML_STRATEGY_ID = 'b3333333-3333-3333-3333-333333333333'

  let app: FastifyInstance

  before(async () => {
    wikiHandle = installTestWiki({
      data: {
        authentication: [
          {
            key: 'local',
            title: 'Local',
            useForm: true,
            icon: '',
            color: 'primary',
            usernameType: 'email'
          },
          {
            key: 'saml',
            title: 'SAML',
            useForm: false,
            icon: '',
            color: 'primary',
            usernameType: 'email'
          }
        ]
      },
      sites: {
        [SITE_ID]: {
          id: SITE_ID,
          config: {
            authStrategies: [
              { id: LOCAL_STRATEGY_ID, order: 0, isVisible: true },
              { id: SAML_STRATEGY_ID, order: 1, isVisible: true }
            ]
          }
        }
      },
      models: {
        authentication: {
          getActiveStrategies: async () => [
            {
              id: LOCAL_STRATEGY_ID,
              module: 'local',
              displayName: 'Local',
              isEnabled: true,
              selfRegistration: true,
              autoProvision: false,
              config: {}
            },
            {
              id: SAML_STRATEGY_ID,
              module: 'saml',
              displayName: 'SAML',
              isEnabled: true,
              selfRegistration: false,
              autoProvision: true,
              config: {}
            }
          ]
        }
      }
    })

    app = await buildTestApp({ routes: authenticationRoutes, ajv: true })
  })

  after(async () => {
    await closeTestApp(app)
    wikiHandle.restore()
  })

  test('carries selfRegistration for a form-based strategy but omits it entirely for a redirect-based one', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${SITE_ID}/auth/strategies`
    })

    assert.equal(res.statusCode, 200)
    const body = res.json() as any[]
    const local = body.find((s) => s.id === LOCAL_STRATEGY_ID)
    const saml = body.find((s) => s.id === SAML_STRATEGY_ID)

    assert.equal(local.activeStrategy.selfRegistration, true)
    assert.equal('selfRegistration' in saml.activeStrategy, false)
  })
})

/**
 * The 404 comes from `siteEnabledPreHandler` rather than the route, so the hook is registered here
 * the way `api/index.ts` registers it around the real plugin.
 */
describe('GET /sites/:siteId/auth/strategies (unknown siteId)', () => {
  let app: FastifyInstance
  const KNOWN_SITE_ID = '33333333-3333-3333-3333-333333333333'

  before(async () => {
    wikiHandle = installTestWiki({
      sites: { [KNOWN_SITE_ID]: { id: KNOWN_SITE_ID, config: { authStrategies: [] } } },
      models: {
        authentication: {
          getActiveStrategies: async () => []
        }
      },
      data: {
        authentication: []
      }
    })

    app = await buildTestApp({ routes: withSiteGuard, ajv: true })
  })

  after(async () => {
    await closeTestApp(app)
    wikiHandle.restore()
  })

  test('answers 404, not 400, for an unknown siteId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sites/00000000-0000-0000-0000-000000000000/auth/strategies'
    })

    assert.equal(res.statusCode, 404)
    assert.equal(res.json().message, SITE_MISSING_MESSAGE)
  })

  test('a known siteId lists its (empty) strategies', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sites/${KNOWN_SITE_ID}/auth/strategies`
    })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), [])
  })
})

/** `minLength` constrains a present value only, so `password` has to be in `required` as well. */
describe('PUT login: password is required by the route schema', () => {
  let app: FastifyInstance
  let loginMock: ReturnType<typeof mock.fn>

  before(async () => {
    wikiHandle = installTestWiki({
      config: { security: { authRateLimitEnabled: false } },
      models: {
        login: {
          login: (...args: any[]) => loginMock(...args)
        },
        flags: {
          authDebug: () => {}
        }
      },
      logger: {
        warn: mock.fn(),
        error: mock.fn(),
        info: mock.fn(),
        debug: mock.fn()
      }
    })

    app = await buildTestApp({ routes: authenticationRoutes, session: () => ({}) })
  })

  after(async () => {
    await closeTestApp(app)
    wikiHandle.restore()
  })

  beforeEach(() => {
    loginMock = mock.fn(async () => ({
      authenticated: true,
      nextAction: 'redirect',
      redirect: '/'
    }))
  })

  const SITE_URL = '/sites/22222222-2222-2222-2222-222222222222/auth/login'
  const STRATEGY_ID = '11111111-1111-1111-1111-111111111111'

  test('an omitted password is rejected as 400 before the model is ever called', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: SITE_URL,
      payload: { strategyId: STRATEGY_ID, username: 'ada' }
    })

    assert.equal(res.statusCode, 400)
    assert.equal(loginMock.mock.calls.length, 0)
  })

  test('an empty-string password is rejected as 400 before the model is ever called', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: SITE_URL,
      payload: { strategyId: STRATEGY_ID, username: 'ada', password: '' }
    })

    assert.equal(res.statusCode, 400)
    assert.equal(loginMock.mock.calls.length, 0)
  })

  test('a present password still reaches the model as before', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: SITE_URL,
      payload: { strategyId: STRATEGY_ID, username: 'ada', password: 'correct-password' }
    })

    assert.equal(res.statusCode, 200)
    assert.equal(loginMock.mock.calls.length, 1)
    const arg = loginMock.mock.calls[0].arguments[0] as any
    assert.equal(arg.password, 'correct-password')
  })

  test('an account-keyed rate limit is answered as 429 with Retry-After, not 400', async () => {
    loginMock = mock.fn(async () => {
      throw new AccountRateLimitedError(55)
    })

    const res = await app.inject({
      method: 'PUT',
      url: SITE_URL,
      payload: { strategyId: STRATEGY_ID, username: 'ada', password: 'correct-password' }
    })

    assert.equal(res.statusCode, 429)
    assert.equal(res.headers['retry-after'], '55')
    const body = JSON.parse(res.body)
    assert.equal(body.ok, false)
  })
})

describe('passkey login endpoints: security.allowPasskeys', () => {
  const SITE_ID = 'c1111111-1111-1111-1111-111111111111'
  const STRATEGY_ID = 'c2222222-2222-2222-2222-222222222222'

  let app: FastifyInstance
  let security: Record<string, any>
  let startLogin: ReturnType<typeof mock.fn>
  let verifyLogin: ReturnType<typeof mock.fn>
  let session: Record<string, any>

  before(async () => {
    startLogin = mock.fn(async () => ({ authOptions: { challenge: 'c' }, pending: 'p' }))
    verifyLogin = mock.fn(async () => ({ nextAction: 'redirect' }))
    security = {}
    wikiHandle = installTestWiki({
      config: { security },
      data: { authentication: [{ key: 'local', title: 'Local', useForm: true }] },
      sites: {
        [SITE_ID]: {
          id: SITE_ID,
          config: { authStrategies: [{ id: STRATEGY_ID, order: 0, isVisible: true }] }
        }
      },
      models: {
        passkeys: { startLogin, verifyLogin },
        authentication: {
          getActiveStrategies: async () => [
            {
              id: STRATEGY_ID,
              module: 'local',
              displayName: 'Local',
              isEnabled: true,
              selfRegistration: true,
              config: {}
            }
          ]
        },
        flags: { authDebug: () => {} },
        rateLimits: { consume: async () => ({ allowed: true, retryAfter: 0 }) }
      }
    })
    app = await buildTestApp({ routes: authenticationRoutes, ajv: true, session: () => session })
  })

  after(async () => {
    await closeTestApp(app)
    wikiHandle.restore()
  })

  beforeEach(() => {
    session = {}
    startLogin.mock.resetCalls()
    verifyLogin.mock.resetCalls()
  })

  test('off refuses the challenge with ERR_PASSKEYS_DISABLED and writes no session challenge', async () => {
    security.allowPasskeys = false
    const res = await app.inject({
      method: 'POST',
      url: `/sites/${SITE_ID}/auth/passkey/challenge`
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().message, 'ERR_PASSKEYS_DISABLED')
    assert.equal(startLogin.mock.calls.length, 0)
    assert.equal(session.passkeyLogin, undefined)
  })

  test('off refuses the login with ERR_PASSKEYS_DISABLED without verifying the assertion', async () => {
    security.allowPasskeys = false
    const res = await app.inject({
      method: 'PUT',
      url: `/sites/${SITE_ID}/auth/passkey/login`,
      payload: { authResponse: { id: 'x' } }
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().message, 'ERR_PASSKEYS_DISABLED')
    assert.equal(verifyLogin.mock.calls.length, 0)
  })

  for (const allowPasskeys of [true, undefined]) {
    test(`on (${allowPasskeys ?? 'absent'}) both endpoints reach the passkey model`, async () => {
      security.allowPasskeys = allowPasskeys
      const challenge = await app.inject({
        method: 'POST',
        url: `/sites/${SITE_ID}/auth/passkey/challenge`
      })
      assert.equal(challenge.statusCode, 200)
      assert.equal(session.passkeyLogin, 'p')
      const login = await app.inject({
        method: 'PUT',
        url: `/sites/${SITE_ID}/auth/passkey/login`,
        payload: { authResponse: { id: 'x' } }
      })
      assert.equal(login.statusCode, 200)
      assert.equal(verifyLogin.mock.calls.length, 1)
    })
  }

  test('the strategies response carries allowPasskeys on each strategy, following the live setting', async () => {
    for (const [setting, expected] of [
      [false, false],
      [true, true],
      [undefined, true]
    ] as const) {
      security.allowPasskeys = setting
      const res = await app.inject({ method: 'GET', url: `/sites/${SITE_ID}/auth/strategies` })
      assert.equal(res.statusCode, 200)
      const body = res.json() as any[]
      assert.equal(body.length, 1)
      assert.equal(body[0].activeStrategy.allowPasskeys, expected)
    }
  })
})
