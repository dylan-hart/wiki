import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fastifyFormBody from '@fastify/formbody'
import authenticationRoutes from './index.ts'
import { ensureTemporal } from '../../test/temporal.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'
import { installTestWiki } from '../../test/mocks.ts'

let wikiHandle: { restore(): void }

/**
 * The route-plugin wrapper this file's apps need on top of the shared harness: a form-body parser,
 * since a SAML-shaped provider POSTs its callback as `application/x-www-form-urlencoded`.
 */
const withFormBody: FastifyPluginAsync = async (instance) => {
  await instance.register(fastifyFormBody)
  await instance.register(authenticationRoutes)
}

/**
 * `POST /auth/:strategyId/callback` is the form-POST counterpart of the existing GET callback, for a
 * provider that answers with a browser form submission rather than a redirect — SAML sends
 * `SAMLResponse` and `RelayState` this way, `RelayState` carrying this route's `state` since SAML
 * defines no `state` parameter of its own (see `AuthFlow.state` in `models/authentication.ts`).
 *
 * `WIKI.auth.strategies[...].profile()` and `WIKI.models.login.loginWithProvider()` are stubbed:
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
    wikiHandle = installTestWiki({
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
        login: {
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
    })

    app = await buildTestApp({
      routes: withFormBody,
      ajv: true,
      // -> No @fastify/session in this unit test: the session is a plain object this suite controls
      //    directly, swapped out per test, standing in for what the real plugin decorates onto the
      //    request.
      session: () => session
    })
  })

  after(async () => {
    await closeTestApp(app)
    wikiHandle.restore()
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
    wikiHandle = installTestWiki({
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
    })

    app = await buildTestApp({
      routes: authenticationRoutes,
      ajv: true,
      session: () => session
    })
  })

  after(async () => {
    await closeTestApp(app)
    wikiHandle.restore()
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
    wikiHandle = installTestWiki({
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
    })

    app = await buildTestApp({
      routes: authenticationRoutes,
      ajv: true,
      session: () => session
    })
  })

  after(async () => {
    await closeTestApp(app)
    wikiHandle.restore()
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
    wikiHandle = installTestWiki({
      config: { security: { disallowOpenRedirect: true, authRateLimitEnabled: false } },
      models: {
        flags: { authDebug: () => {} },
        authentication: {
          getStrategyById: async (id: string) =>
            id === STRATEGY_ID
              ? { id: STRATEGY_ID, module: 'oidc', isEnabled: true, registration: true }
              : null
        },
        login: {
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
    })

    app = await buildTestApp({
      routes: withFormBody,
      ajv: true,
      session: () => session
    })
  })

  after(async () => {
    await closeTestApp(app)
    wikiHandle.restore()
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
