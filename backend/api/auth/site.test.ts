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

/**
 * The two route-plugin wrappers this file's apps need on top of the shared harness: a cookie parser
 * (the logout route clears the session cookie), and the site-enabled guard `api/index.ts` registers
 * around every content route.
 */
const withCookies: FastifyPluginAsync = async (instance) => {
  await instance.register(fastifyCookie)
  await instance.register(authenticationRoutes)
}

const withSiteGuard: FastifyPluginAsync = async (instance) => {
  instance.addHook('preHandler', siteEnabledPreHandler)
  await instance.register(authenticationRoutes)
}
/**
 * `POST /sites/:siteId/auth/register` and `GET /auth/verify/:token` — the request/response wiring
 * around `WIKI.models.login.register()` / `userCredentials.validateToken()` / `users.updateUser()`,
 * which are stubbed here
 * rather than run for real (that's `models/users.test.ts`'s DB-backed coverage of `register()` itself).
 * Registers the whole `authentication.ts` plugin, matching `api/mail.test.ts`'s pattern, since Fastify
 * compiles every route's schema at `ready()` regardless of which ones a given test actually hits.
 */
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
        // -> `register`/`forgotPassword`/`resetPassword` moved to `models/login.ts` and token
        //    validation to `models/userCredentials.ts` when `models/users.ts` was split; the routes
        //    reach them here now.
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
      // -> Stand-in for `@fastify/session`: the resetPassword route writes
      //    `req.session.authenticated` on success the same way `changePassword` does, so
      //    `req.session` has to be a real, mutable, per-request object.
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

  /*
    Feature #2608, Task #2642: the sign-up form sends two authored halves instead of one name, so the
    body's `name` is optional and the two new fields must survive the schema and reach
    `models/login.ts#register` untouched. Nothing in the route derives a display name -- that is
    `models/users.ts#resolveNameFields`'s, once.
  */
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
})

/**
 * #2336: logout's `clearCookie` must carry the same `Path`/`Secure`/`SameSite` attributes as the
 * cookie's registration in `index.ts`, or a real HTTPS deployment's browser rejects the clearing
 * `Set-Cookie` outright (the `__Host-` prefix requires `Secure` on every `Set-Cookie` for that name)
 * and the stale session cookie is never actually removed from the browser.
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
      // -> Stand-in for `@fastify/session`: a plain mutable session object with a `destroy()` spy,
      //    same pattern as the "local account lifecycle" describe above.
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

/**
 * `GET /sites/:siteId/auth/strategies` is public and unauthenticated, so it must never publish more
 * than the login screen can act on. `selfRegistration` is only ever included for a form-based
 * strategy — a redirect-based provider's new-account path is `autoProvision`, which the public login
 * screen has no use for and which used to leak (as `registration`) which provider currently accepted
 * a self-registration POST, the vulnerability WP #2126 closed.
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
 * Task #1680: `GET /sites/:siteId/auth/strategies` used to answer `reply.badRequest('Invalid Site
 * ID')` (400) for an unknown siteId — the only occurrence of that message in the backend, and out of
 * step with every other site-scoped route's 404 for the same condition. Fixed to `reply.notFound()`,
 * and since spec D1 that 404 comes from `siteEnabledPreHandler` — one condition, one message
 * (`SITE_MISSING_MESSAGE`), for every `:siteId` route — rather than from this route's own preamble,
 * so the hook is registered here the way `index.ts` registers it around the real plugin.
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

/**
 * `PUT /sites/:siteId/auth/login`'s body schema (task 2169): `password` used to carry only
 * `minLength: 1`, which constrains a *present* value but does nothing for an omitted key, so
 * `{ strategyId, username }` validated and reached `users.login()` with `password: undefined`.
 * `password` is now in the schema's own `required` list, alongside the pre-existing `strategyId` —
 * this is the first of the fix's two guards (the model-level check in `users.login()` is the second,
 * covered in `models/users.test.ts`).
 */
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

    // -> `buildTestApp` installs the real error handler BEFORE the schemas and routes, which this
    //    block needs: this route's `400` response is `$ref: 'ApiError#'`, which requires an `ok`
    //    field, and Fastify only applies a custom error handler ahead of response-schema
    //    serialization when it is set before the schema that serialization would run against is
    //    compiled in. Registered too late, Fastify's own validation-error body
    //    (`{statusCode, code, error, message}`, no `ok`) fails ApiError serialization and comes back
    //    as a 500 -- a harness ordering artifact the real app never hits.
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

  // -> OpenProject #2361: the account-keyed limiter (`consumeAccountAuthAttempt`, consumed inside
  //    `users.login()`) used to throw a plain `Error('ERR_RATE_LIMITED')`, which this route's
  //    `ERR_`-prefix check mapped to a generic 400 -- unlike the IP-keyed `limitAuthAttempts` hook,
  //    which answers 429 with `Retry-After`. `users.login` now throws the typed
  //    `AccountRateLimitedError` instead, and the route must map *that* to the same 429 contract.
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
