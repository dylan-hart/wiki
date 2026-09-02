import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import fastifyFormBody from '@fastify/formbody'
import fastifyCookie from '@fastify/cookie'
import ajvFormats from 'ajv-formats'
import authenticationRoutes from './authentication.ts'
import { registerSchemas as registerAuthSchema } from './schemas/authentication.ts'
import { registerSchemas as registerErrorSchema } from './schemas/error.ts'
import { AccountRateLimitedError } from '../helpers/rateLimit.ts'
import { siteEnabledPreHandler, SITE_MISSING_MESSAGE } from '../helpers/siteResolution.ts'
import { ensureTemporal } from '../test/temporal.ts'
import { authentication as authenticationTable } from '../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { SESSION_COOKIE_NAME, SESSION_COOKIE_NAME_INSECURE } from '../helpers/security.ts'
import { registerParamsSchemas } from './schemas/params.ts'

/**
 * `POST /auth/:strategyId/callback` is the form-POST counterpart of the existing GET callback, for a
 * provider that answers with a browser form submission rather than a redirect — SAML sends
 * `SAMLResponse` and `RelayState` this way, `RelayState` carrying this route's `state` since SAML
 * defines no `state` parameter of its own (see `AuthFlow.state` in `models/authentication.ts`).
 *
 * `WIKI.auth.strategies[...].profile()` and `WIKI.models.users.loginWithProvider()` are stubbed:
 * what is under test here is the route's flow-matching/expiry/`state` wiring and body parsing, not a
 * real protocol module or the login model, which have their own coverage.
 */
describe('POST/GET /auth/:strategyId/callback (redirect-login providers)', () => {
  const STRATEGY_ID = 'a1111111-1111-1111-1111-111111111111'
  const CAS_STRATEGY_ID = 'a2222222-2222-2222-2222-222222222222'

  let app: FastifyInstance
  let session: Record<string, any>
  let loginCalls: any[]
  let profileCalls: any[]
  let loginResult: Record<string, any>

  function freshFlow(overrides: Record<string, any> = {}) {
    return {
      strategyId: STRATEGY_ID,
      siteId: 'site-1',
      state: 'abc123',
      nonce: 'nonce123',
      codeVerifier: 'verifier123',
      redirect: '/target',
      startedAt: Temporal.Now.instant().toString({ smallestUnit: 'millisecond' }),
      ...overrides
    }
  }

  beforeEach(() => {
    loginCalls = []
    profileCalls = []
    loginResult = { authenticated: true, nextAction: 'redirect', redirect: '/welcome' }
  })

  before(async () => {
    await ensureTemporal()
    loginCalls = []
    profileCalls = []
    loginResult = { authenticated: true, nextAction: 'redirect', redirect: '/welcome' }
    ;(globalThis as any).WIKI = {
      config: { security: { authRateLimitEnabled: false } },
      models: {
        flags: { authDebug: () => {} },
        authentication: {
          getStrategyById: async (id: string) =>
            id === STRATEGY_ID
              ? { id: STRATEGY_ID, module: 'saml', isEnabled: true, autoProvision: true }
              : id === CAS_STRATEGY_ID
                ? { id: CAS_STRATEGY_ID, module: 'cas', isEnabled: true, autoProvision: true }
                : null
        },
        users: {
          loginWithProvider: async (args: any) => {
            loginCalls.push(args)
            return loginResult
          }
        }
      },
      sitesMappings: {},
      auth: {
        strategies: {
          [STRATEGY_ID]: {
            module: 'saml',
            profile: async () => ({ id: 'ext-1', email: 'ada@example.com', name: 'Ada Lovelace' }),
            authorizationUrl: async () => 'https://idp.example.com/authorize?x=1'
          },
          [CAS_STRATEGY_ID]: {
            module: 'cas',
            profile: async (args: any) => {
              profileCalls.push(args)
              return { id: 'alice', email: 'alice@example.com', name: 'Alice Example' }
            }
          }
        }
      }
    }

    app = fastify({
      ajv: {
        plugins: [[ajvFormats.default, {}] as any]
      }
    })
    await app.register(fastifySensible)
    await app.register(fastifyFormBody)
    await registerErrorSchema(app)
    await registerAuthSchema(app)
    // -> No @fastify/session in this unit test: the session is a plain object this suite controls
    //    directly, swapped out per test, standing in for what the real plugin decorates onto the request.
    app.addHook('onRequest', async (req) => {
      ;(req as any).session = session
    })
    await registerParamsSchemas(app)
    await app.register(authenticationRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  test('round-trips a matching RelayState into a login and redirects where it resolved', async () => {
    session = { authFlow: freshFlow() }

    const res = await app.inject({
      method: 'POST',
      url: `/auth/${STRATEGY_ID}/callback`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        SAMLResponse: 'encoded-response',
        RelayState: 'abc123'
      }).toString()
    })

    assert.equal(res.statusCode, 302)
    assert.equal(res.headers.location, '/welcome')
    // -> The flow is spent, matching the GET callback's own behavior
    assert.equal(session.authFlow, undefined)
    assert.equal(loginCalls.length, 1)
    assert.equal(loginCalls[0].profile.email, 'ada@example.com')
    assert.equal(loginCalls[0].siteId, 'site-1')
  })

  test('a RelayState that does not match the session flow is refused, login not attempted', async () => {
    session = { authFlow: freshFlow() }

    const res = await app.inject({
      method: 'POST',
      url: `/auth/${STRATEGY_ID}/callback`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        SAMLResponse: 'encoded-response',
        RelayState: 'not-the-flow-state'
      }).toString()
    })

    assert.equal(res.statusCode, 302)
    assert.match(res.headers.location as string, /^\/login\?error=ERR_LOGIN_EXPIRED/)
    assert.equal(loginCalls.length, 0)
  })

  test('a callback with no authFlow on the session at all is refused', async () => {
    session = {}

    const res = await app.inject({
      method: 'POST',
      url: `/auth/${STRATEGY_ID}/callback`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ RelayState: 'abc123' }).toString()
    })

    assert.equal(res.statusCode, 302)
    assert.match(res.headers.location as string, /^\/login\?error=ERR_LOGIN_EXPIRED/)
    assert.equal(loginCalls.length, 0)
  })

  /**
   * CAS reads `state` off the query string exactly like an OAuth2/OIDC provider does — see `AuthFlow.state`
   * in `models/authentication.ts` — but carries its own answer in `ticket` rather than `code`. This is the
   * route-level half of that wiring: the GET callback's typed querystring and the object handed to the
   * module's `profile()` both need a `ticket` field alongside `code`, or a CAS module never sees the ticket
   * CAS granted.
   */
  test("a GET callback forwards `ticket` (not `code`) to the module's profile(), alongside `state`", async () => {
    session = { authFlow: freshFlow({ strategyId: CAS_STRATEGY_ID }) }

    const res = await app.inject({
      method: 'GET',
      url: `/auth/${CAS_STRATEGY_ID}/callback?ticket=ST-abc123&state=abc123`
    })

    assert.equal(res.statusCode, 302)
    assert.equal(res.headers.location, '/welcome')
    assert.equal(profileCalls.length, 1)
    assert.equal(profileCalls[0].ticket, 'ST-abc123')
    assert.equal(profileCalls[0].state, 'abc123')
    assert.equal(profileCalls[0].code, undefined)
  })

  test('an expired flow is refused even with a matching RelayState', async () => {
    session = {
      authFlow: freshFlow({
        startedAt: Temporal.Now.instant()
          .subtract({ hours: 1 })
          .toString({ smallestUnit: 'millisecond' })
      })
    }

    const res = await app.inject({
      method: 'POST',
      url: `/auth/${STRATEGY_ID}/callback`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ RelayState: 'abc123' }).toString()
    })

    assert.equal(res.statusCode, 302)
    assert.match(res.headers.location as string, /^\/login\?error=ERR_LOGIN_EXPIRED/)
    assert.equal(loginCalls.length, 0)
  })

  /**
   * `result.redirect` carries a group's `redirectOnLogin`, set by a `manage:groups` holder with no
   * validation at write time (`api/groups.ts`) — see WP #2215 / epic #2208 §6. This route is the
   * emitter: it must refuse anything that isn't a safe same-wiki path or complete http(s) URL rather
   * than hand it to `reply.redirect()` as-is, falling back to the flow's own already-safe `redirect`.
   */
  test('a javascript: result.redirect is refused and falls back to the flow redirect, not emitted as Location', async () => {
    session = { authFlow: freshFlow() }
    loginResult = { authenticated: true, nextAction: 'redirect', redirect: 'javascript:alert(1)' }

    const res = await app.inject({
      method: 'POST',
      url: `/auth/${STRATEGY_ID}/callback`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        SAMLResponse: 'encoded-response',
        RelayState: 'abc123'
      }).toString()
    })

    assert.equal(res.statusCode, 302)
    assert.equal(res.headers.location, '/target')
  })

  test('a scheme-relative //host result.redirect is refused the same way', async () => {
    session = { authFlow: freshFlow() }
    loginResult = { authenticated: true, nextAction: 'redirect', redirect: '//attacker.example' }

    const res = await app.inject({
      method: 'POST',
      url: `/auth/${STRATEGY_ID}/callback`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        SAMLResponse: 'encoded-response',
        RelayState: 'abc123'
      }).toString()
    })

    assert.equal(res.statusCode, 302)
    assert.equal(res.headers.location, '/target')
  })

  test('a safe result.redirect still round-trips through the callback flow', async () => {
    session = { authFlow: freshFlow() }
    loginResult = { authenticated: true, nextAction: 'redirect', redirect: '/welcome' }

    const res = await app.inject({
      method: 'POST',
      url: `/auth/${STRATEGY_ID}/callback`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        SAMLResponse: 'encoded-response',
        RelayState: 'abc123'
      }).toString()
    })

    assert.equal(res.statusCode, 302)
    assert.equal(res.headers.location, '/welcome')
  })
})

/**
 * `GET /auth/:strategyId/authorize` — the open-redirect fix at the start of a provider login. The
 * caller-supplied `redirect` query parameter is stored on the session's `authFlow` for the callback
 * to use later; this suite asserts what actually lands there, rather than the provider redirect
 * itself (`instance.authorizationUrl` is stubbed to a fixed string — the module's own concern).
 */
describe('GET /auth/:strategyId/authorize (open redirect on the redirect query param)', () => {
  const STRATEGY_ID = 'b1111111-1111-1111-1111-111111111111'

  let app: FastifyInstance
  let session: Record<string, any>

  before(async () => {
    ;(globalThis as any).WIKI = {
      config: { security: { authRateLimitEnabled: false } },
      models: {
        flags: { authDebug: () => {} },
        authentication: {
          getStrategyById: async (id: string) =>
            id === STRATEGY_ID
              ? { id: STRATEGY_ID, module: 'oidc', isEnabled: true, registration: true }
              : null
        }
      },
      auth: {
        strategies: {
          [STRATEGY_ID]: {
            module: 'oidc',
            authorizationUrl: async () => 'https://provider.example/authorize?state=abc'
          }
        }
      },
      sitesMappings: {}
    }

    app = fastify({
      ajv: {
        plugins: [[ajvFormats.default, {}] as any]
      }
    })
    await app.register(fastifySensible)
    await registerErrorSchema(app)
    await registerAuthSchema(app)
    app.addHook('onRequest', async (req) => {
      ;(req as any).session = session
    })
    await registerParamsSchemas(app)
    await app.register(authenticationRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  beforeEach(() => {
    session = {}
  })

  test('a //host redirect query param does not survive into the stored flow', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/auth/${STRATEGY_ID}/authorize?redirect=${encodeURIComponent('//attacker.example')}`
    })

    assert.equal(res.statusCode, 302)
    assert.equal(session.authFlow.redirect, '/')
  })

  test('a /\\host redirect query param (browser-normalised to //) does not survive either', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/auth/${STRATEGY_ID}/authorize?redirect=${encodeURIComponent('/\\attacker.example')}`
    })

    assert.equal(res.statusCode, 302)
    assert.equal(session.authFlow.redirect, '/')
  })

  test('a javascript: redirect query param does not survive either', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/auth/${STRATEGY_ID}/authorize?redirect=${encodeURIComponent('javascript:alert(1)')}`
    })

    assert.equal(res.statusCode, 302)
    assert.equal(session.authFlow.redirect, '/')
  })

  test('a rooted path redirect query param round-trips into the stored flow unchanged', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/auth/${STRATEGY_ID}/authorize?redirect=${encodeURIComponent('/en/target-page')}`
    })

    assert.equal(res.statusCode, 302)
    assert.equal(session.authFlow.redirect, '/en/target-page')
  })

  test('no redirect query param at all stores the / fallback', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/auth/${STRATEGY_ID}/authorize`
    })

    assert.equal(res.statusCode, 302)
    assert.equal(session.authFlow.redirect, '/')
  })
})

/**
 * OpenProject #2208 §6: `GET /auth/:strategyId/authorize`'s `redirect` query parameter used to be
 * guarded with `startsWith('/')` alone -- `'//attacker.example'.startsWith('/')` is true, and a
 * browser resolves a leading `/\` the same protocol-relative way, so both reached the provider round
 * trip and came back as an absolute cross-origin `Location`. Checked here against the flow stored on
 * the session, since the response itself redirects to the PROVIDER, not to `redirect` -- `redirect`
 * only takes effect later, at the callback (covered by the describe block below this one).
 */
describe('GET /auth/:strategyId/authorize — redirect query validation', () => {
  const STRATEGY_ID = 'a3333333-3333-3333-3333-333333333333'
  let app: FastifyInstance
  let session: Record<string, any>

  before(async () => {
    if (typeof Temporal === 'undefined') {
      const polyfill = await import('@js-temporal/polyfill')
      ;(globalThis as any).Temporal = polyfill.Temporal
    }
    ;(globalThis as any).WIKI = {
      config: { security: { disallowOpenRedirect: true, authRateLimitEnabled: false } },
      sitesMappings: {},
      models: {
        flags: { authDebug: () => {} },
        authentication: {
          getStrategyById: async (id: string) =>
            id === STRATEGY_ID ? { id: STRATEGY_ID, module: 'oidc', isEnabled: true } : null
        }
      },
      auth: {
        strategies: {
          [STRATEGY_ID]: {
            module: 'oidc',
            authorizationUrl: async () => 'https://provider.example/authorize'
          }
        }
      }
    }

    app = fastify({
      ajv: {
        plugins: [[ajvFormats.default, {}] as any]
      }
    })
    await app.register(fastifySensible)
    await registerErrorSchema(app)
    await registerAuthSchema(app)
    app.addHook('onRequest', async (req) => {
      ;(req as any).session = session
    })
    await registerParamsSchemas(app)
    await app.register(authenticationRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  beforeEach(() => {
    session = {}
  })

  test('?redirect=//attacker.example lands the stored flow on / (protocol-relative)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/auth/${STRATEGY_ID}/authorize?redirect=${encodeURIComponent('//attacker.example')}`
    })
    assert.equal(res.statusCode, 302)
    assert.equal(res.headers.location, 'https://provider.example/authorize')
    assert.equal(session.authFlow.redirect, '/')
  })

  test('?redirect=/\\attacker.example lands the stored flow on / (browser-normalized to //)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/auth/${STRATEGY_ID}/authorize?redirect=${encodeURIComponent('/\\attacker.example')}`
    })
    assert.equal(res.statusCode, 302)
    assert.equal(session.authFlow.redirect, '/')
  })

  test('?redirect=javascript:alert(1) lands the stored flow on /', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/auth/${STRATEGY_ID}/authorize?redirect=${encodeURIComponent('javascript:alert(1)')}`
    })
    assert.equal(res.statusCode, 302)
    assert.equal(session.authFlow.redirect, '/')
  })

  test('a rooted path still round-trips through the stored flow', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/auth/${STRATEGY_ID}/authorize?redirect=${encodeURIComponent('/dashboard')}`
    })
    assert.equal(res.statusCode, 302)
    assert.equal(session.authFlow.redirect, '/dashboard')
  })

  test('an absent redirect defaults the stored flow to /', async () => {
    const res = await app.inject({ method: 'GET', url: `/auth/${STRATEGY_ID}/authorize` })
    assert.equal(res.statusCode, 302)
    assert.equal(session.authFlow.redirect, '/')
  })
})

/**
 * OpenProject #2208 §6: the callback's `reply.redirect(result.redirect || redirect)` used to emit
 * `result.redirect` -- ultimately a group's `redirectOnLogin`/`redirectOnFirstLogin` -- as a raw
 * `Location` header with no validation of its own, so an unvalidated stored value became a
 * server-emitted header on this specific route even before OpenProject #2208's group/site field
 * validation (#2214) existed. Covered here independently of that fix, since this route must refuse
 * such a value regardless of whether it ever should have been stored in the first place.
 */
describe('GET/POST /auth/:strategyId/callback — result.redirect validation', () => {
  const STRATEGY_ID = 'a4444444-4444-4444-4444-444444444444'
  let app: FastifyInstance
  let session: Record<string, any>
  let providerResult: Record<string, any>

  function freshFlow(overrides: Record<string, any> = {}) {
    return {
      strategyId: STRATEGY_ID,
      siteId: 'site-1',
      state: 'abc123',
      nonce: 'nonce123',
      codeVerifier: 'verifier123',
      redirect: '/target',
      startedAt: Temporal.Now.instant().toString({ smallestUnit: 'millisecond' }),
      ...overrides
    }
  }

  before(async () => {
    if (typeof Temporal === 'undefined') {
      const polyfill = await import('@js-temporal/polyfill')
      ;(globalThis as any).Temporal = polyfill.Temporal
    }
    ;(globalThis as any).WIKI = {
      config: { security: { disallowOpenRedirect: true, authRateLimitEnabled: false } },
      models: {
        flags: { authDebug: () => {} },
        authentication: {
          getStrategyById: async (id: string) =>
            id === STRATEGY_ID
              ? { id: STRATEGY_ID, module: 'oidc', isEnabled: true, registration: true }
              : null
        },
        users: {
          loginWithProvider: async () => providerResult
        }
      },
      auth: {
        strategies: {
          [STRATEGY_ID]: {
            module: 'oidc',
            profile: async () => ({ id: 'ext-1', email: 'ada@example.com', name: 'Ada Lovelace' })
          }
        }
      }
    }

    app = fastify({
      ajv: {
        plugins: [[ajvFormats.default, {}] as any]
      }
    })
    await app.register(fastifySensible)
    await app.register(fastifyFormBody)
    await registerErrorSchema(app)
    await registerAuthSchema(app)
    app.addHook('onRequest', async (req) => {
      ;(req as any).session = session
    })
    await registerParamsSchemas(app)
    await app.register(authenticationRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  beforeEach(() => {
    session = { authFlow: freshFlow() }
  })

  test('a javascript: result.redirect is not emitted as the Location header -- falls back to the flow redirect', async () => {
    providerResult = {
      authenticated: true,
      nextAction: 'redirect',
      redirect: 'javascript:alert(1)'
    }

    const res = await app.inject({
      method: 'GET',
      url: `/auth/${STRATEGY_ID}/callback?code=abc&state=abc123`
    })

    assert.equal(res.statusCode, 302)
    assert.equal(res.headers.location, '/target')
  })

  test('a protocol-relative //host result.redirect is not emitted -- falls back to the flow redirect', async () => {
    providerResult = { authenticated: true, nextAction: 'redirect', redirect: '//evil.example' }

    const res = await app.inject({
      method: 'GET',
      url: `/auth/${STRATEGY_ID}/callback?code=abc&state=abc123`
    })

    assert.equal(res.statusCode, 302)
    assert.equal(res.headers.location, '/target')
  })

  test('a valid rooted result.redirect is used as the Location header', async () => {
    providerResult = { authenticated: true, nextAction: 'redirect', redirect: '/welcome' }

    const res = await app.inject({
      method: 'GET',
      url: `/auth/${STRATEGY_ID}/callback?code=abc&state=abc123`
    })

    assert.equal(res.statusCode, 302)
    assert.equal(res.headers.location, '/welcome')
  })

  test('no result.redirect at all falls back to the flow redirect', async () => {
    providerResult = { authenticated: true, nextAction: 'redirect' }

    const res = await app.inject({
      method: 'GET',
      url: `/auth/${STRATEGY_ID}/callback?code=abc&state=abc123`
    })

    assert.equal(res.statusCode, 302)
    assert.equal(res.headers.location, '/target')
  })
})

/**
 * `POST /sites/:siteId/auth/register` and `GET /auth/verify/:token` — the request/response wiring
 * around `WIKI.models.users.register()` / `validateToken()` / `updateUser()`, which are stubbed here
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
    await registerErrorSchema(app)
    await registerAuthSchema(app)
    await registerParamsSchemas(app)
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
    ;(globalThis as any).WIKI = {
      config: { security: { cookieSecure } },
      models: {
        flags: { authDebug: () => {} },
        users: {
          getLogoutRedirect: async () => '/'
        },
        hooks: {
          emit: async () => 0
        }
      }
    }

    const built = fastify()
    await built.register(fastifyCookie)
    await built.register(fastifySensible)
    await registerErrorSchema(built)
    await registerAuthSchema(built)
    // -> Stand-in for `@fastify/session`: a plain mutable session object with a `destroy()` spy,
    //    same pattern as the "local account lifecycle" describe above.
    built.addHook('onRequest', async (req) => {
      ;(req as any).session = {
        authenticated: false,
        destroy: destroyMock
      }
    })
    await registerParamsSchemas(built)
    await built.register(authenticationRoutes)
    await built.ready()
    return built
  }

  beforeEach(() => {
    destroyMock = mock.fn(async () => {})
  })

  after(async () => {
    if (app) await app.close()
    delete (globalThis as any).WIKI
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
 * #1616: `POST /authentication/strategies` used to answer an unknown `module` with a hardcoded
 * English sentence, which surfaced verbatim in the UI instead of translating like the rest of a
 * `t(key, fallback)` screen. Assert the coded `ERR_*` shape rather than any particular wording.
 */
describe('POST /authentication/strategies (unknown module)', () => {
  let app: FastifyInstance

  before(async () => {
    ;(globalThis as any).WIKI = {
      models: {
        authentication: {
          getModule: () => null
        }
      }
    }

    app = fastify()
    await app.register(fastifySensible)
    // -> Mirrors `index.ts`'s real `setErrorHandler`: a `reply.badRequest()` is a thrown
    //    `@fastify/sensible` error, and it is THIS handler -- not fastify's default -- that shapes
    //    it into the `{ ok, error, statusCode, message }` the `ApiError` schema expects.
    app.setErrorHandler((error: any, req, reply) => {
      reply.code(error.statusCode ?? 500).send({
        ok: false,
        error: error.name,
        statusCode: error.statusCode ?? 500,
        message: error.message
      })
    })
    await registerErrorSchema(app)
    await registerAuthSchema(app)
    await registerParamsSchemas(app)
    await app.register(authenticationRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  test('POST /authentication/strategies rejects an unknown module with a coded error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/authentication/strategies',
      payload: { module: 'not-a-real-module' }
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().message, 'ERR_UNKNOWN_AUTH_MODULE')
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
    ;(globalThis as any).WIKI = {
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
    }

    app = fastify({
      ajv: {
        plugins: [[ajvFormats.default, {}] as any]
      }
    })
    await app.register(fastifySensible)
    await registerErrorSchema(app)
    await registerAuthSchema(app)
    await registerParamsSchemas(app)
    await app.register(authenticationRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
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
    ;(globalThis as any).WIKI = {
      sites: { [KNOWN_SITE_ID]: { id: KNOWN_SITE_ID, config: { authStrategies: [] } } },
      models: {
        authentication: {
          getActiveStrategies: async () => []
        }
      },
      data: {
        authentication: []
      }
    }

    app = fastify({
      ajv: {
        plugins: [[ajvFormats.default, {}] as any]
      }
    })
    await app.register(fastifySensible)
    // -> Mirrors `index.ts`'s real `setErrorHandler`: a `reply.notFound()` is a thrown
    //    `@fastify/sensible` error, and it is THIS handler -- not fastify's default -- that shapes it
    //    into the `{ ok, error, statusCode, message }` the `ApiError` schema expects.
    app.setErrorHandler((error: any, req, reply) => {
      reply.code(error.statusCode ?? 500).send({
        ok: false,
        error: error.name,
        statusCode: error.statusCode ?? 500,
        message: error.message
      })
    })
    await registerErrorSchema(app)
    await registerAuthSchema(app)
    app.addHook('preHandler', siteEnabledPreHandler)
    await registerParamsSchemas(app)
    await app.register(authenticationRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
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
    ;(globalThis as any).WIKI = {
      config: { security: { authRateLimitEnabled: false } },
      models: {
        users: {
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
    }

    app = fastify()
    await app.register(fastifySensible)
    app.decorateRequest('session', null as any)
    app.addHook('onRequest', async (req) => {
      req.session = {} as any
    })
    // -> Mirrors `index.ts`'s real `setErrorHandler`, and — unlike the `local account lifecycle`
    //    block above, whose routes declare no `400` response schema — must be registered before the
    //    schemas/routes below: this route's `400` response is `$ref: 'ApiError#'`, which requires an
    //    `ok` field, and Fastify only applies a custom error handler ahead of response-schema
    //    serialization when it is set before the schema that serialization would run against is
    //    compiled in. Left unset (or registered too late), Fastify's own validation-error body
    //    (`{statusCode, code, error, message}`, no `ok`) fails ApiError serialization and comes back
    //    as a 500 -- a test-harness ordering artifact this app never hits in production, where
    //    `index.ts` always shapes `/_api/` errors this way first.
    app.setErrorHandler((error: any, req, reply) => {
      reply.code(error.statusCode ?? 500).send({
        ok: false,
        error: error.name,
        statusCode: error.statusCode ?? 500,
        message: error.message
      })
    })
    await registerErrorSchema(app)
    await registerAuthSchema(app)
    await registerParamsSchemas(app)
    await app.register(authenticationRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
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

/**
 * OpenProject #2234: a strategy save is one of the most permission-affecting operations in the
 * product (it decides which strategies exist, are enabled, and which groups they auto-enroll), and
 * left no audit record at all before this. DB-backed, against the real `models/authentication.ts`
 * and `models/auditLog.ts` -- the point under test is that a real update through the real route
 * writes a real row, not that a stub was called with the right arguments.
 */
describe(
  'PUT /authentication/strategies/:strategyId — records auth.strategyUpdated (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let app: FastifyInstance
    let fixtures: TestFixtures
    let strategyId: string

    before(async () => {
      fixtures = await setupTestDb()
      // -> `validateStrategy()` (`models/authentication.ts`) reads `WIKI.data.systemIds.localAuthId`
      //    unconditionally to decide whether the strategy being saved is the un-disableable built-in
      //    one -- `setupTestDb()` leaves `WIKI.data` empty, so this has to be set before any save can
      //    run at all. Deliberately not the fixture strategy's own id, so it is treated as an
      //    ordinary (not built-in) strategy, matching what this test is actually saving.
      ;(globalThis as any).WIKI.data.systemIds = { localAuthId: 'not-this-strategy' }

      const [strategy] = await fixtures.db
        .insert(authenticationTable)
        .values({
          module: 'test-module',
          displayName: 'Test Strategy',
          isEnabled: true,
          config: {}
        })
        .returning({ id: authenticationTable.id })
      strategyId = strategy!.id

      app = fastify({
        ajv: {
          plugins: [[ajvFormats.default, {}] as any]
        }
      })
      await app.register(fastifySensible)
      app.setErrorHandler((error: any, req, reply) => {
        reply.code(error.statusCode ?? 500).send({
          ok: false,
          error: error.name,
          statusCode: error.statusCode ?? 500,
          message: error.message
        })
      })
      await registerErrorSchema(app)
      await registerAuthSchema(app)
      // -> Stand-in for `@fastify/session` + the real login-established `req.session.user`: what
      //    `actorFromRequest()` (`models/auditLog.ts`) reads to name the actor.
      app.decorateRequest('session', null as any)
      app.addHook('onRequest', async (req) => {
        req.session = { user: { id: fixtures.userId, name: 'Fixture User' } } as any
      })
      await registerParamsSchemas(app)
      await app.register(authenticationRoutes)
      await app.ready()
    })

    after(async () => {
      await app.close()
      await teardownTestDb()
    })

    test('a strategy save writes one auth.strategyUpdated row naming the actor and strategy module, never a secret value', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/authentication/strategies/${strategyId}`,
        payload: {
          displayName: 'Renamed Strategy',
          config: { clientSecret: 'super-secret-value' }
        }
      })

      assert.equal(res.statusCode, 200)
      assert.equal(res.json().ok, true)

      const { entries } = await WIKI.models.auditLog.list({ event: 'auth.strategyUpdated' })
      assert.equal(entries.length, 1)
      const entry = entries[0]!
      assert.equal(entry.actor.id, fixtures.userId)
      assert.equal(entry.actor.name, 'Fixture User')
      assert.equal(entry.targetType, 'authStrategy')
      assert.equal(entry.targetId, strategyId)
      assert.equal(entry.detail.module, 'test-module')
      assert.deepEqual([...entry.detail.changedFields].sort(), ['config', 'displayName'])
      // -> `detail` names which fields changed, never their values -- the secret submitted above
      //    must not surface anywhere in the recorded entry.
      assert.doesNotMatch(JSON.stringify(entry.detail), /super-secret-value/)
    })
  }
)
