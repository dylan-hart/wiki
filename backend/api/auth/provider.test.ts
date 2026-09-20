import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, mock, test } from 'node:test'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import fastifyFormBody from '@fastify/formbody'
import authenticationRoutes from './index.ts'
import { ensureTemporal } from '../../test/temporal.ts'
import { buildTestApp, closeTestApp } from '../../test/fastify.ts'
import { installTestWiki } from '../../test/mocks.ts'

let wikiHandle: { restore(): void }

/** A SAML-shaped provider POSTs its callback as `application/x-www-form-urlencoded`. */
const withFormBody: FastifyPluginAsync = async (instance) => {
  await instance.register(fastifyFormBody)
  await instance.register(authenticationRoutes)
}

/**
 * SAML answers with a browser form POST, `RelayState` carrying this route's `state` since SAML
 * defines no `state` parameter of its own. The module's `profile()` and `loginWithProvider()` are
 * stubbed: the route's flow matching, expiry and body parsing are what is under test.
 */
describe('POST/GET /auth/:strategyId/callback (redirect-login providers)', () => {
  const STRATEGY_ID = 'a1111111-1111-1111-1111-111111111111'
  const CAS_STRATEGY_ID = 'a2222222-2222-2222-2222-222222222222'

  let app: FastifyInstance
  let session: Record<string, any>
  let loginCalls: any[]
  let profileCalls: any[]
  let loginResult: Record<string, any>
  let profileOverride: Record<string, any> = {}
  let loginError: Error | null = null

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
    profileOverride = {}
    loginError = null
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
        auditLog: { record: async () => {} },
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
            if (loginError) {
              throw loginError
            }
            return loginResult
          }
        }
      },
      sitesMappings: {},
      auth: {
        strategies: {
          [STRATEGY_ID]: {
            module: 'saml',
            profile: async () => ({
              id: 'ext-1',
              email: 'ada@example.com',
              name: 'Ada Lovelace',
              ...profileOverride
            }),
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
    // -> A flow is single-use
    assert.equal(session.authFlow, undefined)
    assert.equal(loginCalls.length, 1)
    assert.equal(loginCalls[0].profile.email, 'ada@example.com')
    assert.equal(loginCalls[0].siteId, 'site-1')
  })

  describe('retaining the provider ID token', () => {
    function callback() {
      return app.inject({
        method: 'POST',
        url: `/auth/${STRATEGY_ID}/callback`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ SAMLResponse: 'r', RelayState: 'abc123' }).toString()
      })
    }

    test('a completed login with an ID token leaves the strategy id and token on the session', async () => {
      session = { authFlow: freshFlow() }
      profileOverride = { idToken: 'header.payload.sig' }

      const res = await callback()

      assert.equal(res.statusCode, 302)
      assert.deepEqual(session.idpSession, {
        strategyId: STRATEGY_ID,
        idToken: 'header.payload.sig'
      })
    })

    test('a login whose profile carries no ID token stores none', async () => {
      session = { authFlow: freshFlow() }

      await callback()

      assert.equal(session.idpSession, undefined)
    })

    test('a login stopped short of a session (2FA, password change) stores none', async () => {
      session = { authFlow: freshFlow() }
      profileOverride = { idToken: 'header.payload.sig' }
      loginResult = { nextAction: 'provideTfa', continuationToken: 't', redirect: '/' }

      await callback()

      assert.equal(session.idpSession, undefined)
    })

    test('a failed login stores none', async () => {
      session = { authFlow: freshFlow() }
      profileOverride = { idToken: 'header.payload.sig' }
      loginError = new Error('ERR_LOGIN_FAILED')

      const res = await callback()

      assert.match(res.headers.location as string, /^\/login\?error=ERR_LOGIN_FAILED/)
      assert.equal(session.idpSession, undefined)
    })
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

  /** CAS answers with `ticket` where an OAuth2/OIDC provider answers with `code`. */
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

  /** `result.redirect` is a group's stored `redirectOnLogin`; the route re-checks it. */
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
 * The response redirects to the provider; `redirect` only takes effect later, at the callback. So
 * these assert what is stored on the session's `authFlow`.
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

describe('GET /auth/:strategyId/authorize — redirect query validation', () => {
  const STRATEGY_ID = 'a3333333-3333-3333-3333-333333333333'
  let app: FastifyInstance
  let session: Record<string, any>

  before(async () => {
    await ensureTemporal()
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
 * The route refuses an unsafe stored `redirectOnLogin`/`redirectOnFirstLogin` itself, whether or
 * not write-time validation should have kept it out of the database.
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
    await ensureTemporal()
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

describe('GET/POST /auth/:strategyId/callback — login.failed audit recording', () => {
  const STRATEGY_ID = 'a5555555-5555-5555-5555-555555555555'
  let app: FastifyInstance
  let session: Record<string, any>
  let auditLogRecord: ReturnType<typeof mock.fn>
  let profileImpl: () => Promise<any>

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
    await ensureTemporal()
    wikiHandle = installTestWiki({
      config: { security: { authRateLimitEnabled: false } },
      models: {
        flags: { authDebug: () => {} },
        authentication: {
          getStrategyById: async (id: string) =>
            id === STRATEGY_ID
              ? { id: STRATEGY_ID, module: 'oidc', isEnabled: true, registration: true }
              : null
        },
        login: {
          loginWithProvider: async () => {
            throw new Error('ERR_ACCOUNT_NOT_LINKED')
          }
        },
        auditLog: {
          record: (...args: any[]) => auditLogRecord(...args)
        }
      },
      auth: {
        strategies: {
          [STRATEGY_ID]: {
            module: 'oidc',
            profile: async () => profileImpl()
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
    auditLogRecord = mock.fn(async () => {})
  })

  test('a loginWithProvider() refusal after a resolved profile records login.failed, named by the profile email', async () => {
    profileImpl = async () => ({ id: 'ext-1', email: 'ada@example.com', name: 'Ada Lovelace' })

    const res = await app.inject({
      method: 'GET',
      url: `/auth/${STRATEGY_ID}/callback?code=abc&state=abc123`
    })

    assert.equal(res.statusCode, 302)
    assert.match(res.headers.location as string, /^\/login\?error=ERR_ACCOUNT_NOT_LINKED/)

    assert.equal(auditLogRecord.mock.callCount(), 1)
    const entry = (auditLogRecord.mock.calls[0].arguments as any)[0]
    assert.equal(entry.event, 'login.failed')
    // -> No local user is resolved at this layer, so the provider-asserted email names the actor
    assert.deepEqual(entry.actor, { id: null, name: 'ada@example.com', ip: '127.0.0.1' })
    assert.equal(entry.targetType, 'user')
    assert.equal(entry.targetLabel, 'ada@example.com')
    assert.deepEqual(entry.detail, { strategyId: STRATEGY_ID, reason: 'ERR_ACCOUNT_NOT_LINKED' })
    assert.equal(entry.siteId, 'site-1')
  })

  test('a profile() failure with no identity resolved yet still records login.failed, naming nobody', async () => {
    profileImpl = async () => {
      throw new Error('ERR_LOGIN_FAILED')
    }

    const res = await app.inject({
      method: 'GET',
      url: `/auth/${STRATEGY_ID}/callback?code=abc&state=abc123`
    })

    assert.equal(res.statusCode, 302)

    assert.equal(auditLogRecord.mock.callCount(), 1)
    const entry = (auditLogRecord.mock.calls[0].arguments as any)[0]
    assert.equal(entry.event, 'login.failed')
    assert.deepEqual(entry.actor, { id: null, name: '', ip: '127.0.0.1' })
    assert.equal(entry.targetLabel, '')
    assert.deepEqual(entry.detail, { strategyId: STRATEGY_ID, reason: 'ERR_LOGIN_FAILED' })
  })
})

describe('GET /auth/:strategyId/metadata', () => {
  const SAML_ID = 'c1111111-1111-1111-1111-111111111111'
  const DISABLED_ID = 'c2222222-2222-2222-2222-222222222222'
  const OIDC_ID = 'c3333333-3333-3333-3333-333333333333'
  const BROKEN_ID = 'c4444444-4444-4444-4444-444444444444'
  const CRASHING_ID = 'c5555555-5555-5555-5555-555555555555'
  const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----SECRETKEYMATERIAL-----END PRIVATE KEY-----'

  let app: FastifyInstance
  let metadataArgs: string[]

  /** Shaped like `SamlAuthentication`: the private key sits in the instance's config, not its output. */
  function samlInstance(id: string) {
    return {
      module: 'saml',
      conf: { privateKey: PRIVATE_KEY },
      metadata(acsUrl: string) {
        metadataArgs.push(acsUrl)
        return `<EntityDescriptor entityID="urn:cardinal:${id}"><AssertionConsumerService Location="${acsUrl}"/></EntityDescriptor>`
      }
    }
  }

  before(async () => {
    wikiHandle = installTestWiki({
      config: { security: { authRateLimitEnabled: true } },
      models: {
        flags: { authDebug: () => {} },
        authentication: {
          getStrategyById: async (id: string) =>
            ({
              [SAML_ID]: { id: SAML_ID, module: 'saml', isEnabled: true },
              [DISABLED_ID]: { id: DISABLED_ID, module: 'saml', isEnabled: false },
              [OIDC_ID]: { id: OIDC_ID, module: 'oidc', isEnabled: true },
              [BROKEN_ID]: { id: BROKEN_ID, module: 'saml', isEnabled: true },
              [CRASHING_ID]: { id: CRASHING_ID, module: 'saml', isEnabled: true }
            })[id] ?? null
        }
      },
      auth: {
        strategies: {
          [SAML_ID]: samlInstance(SAML_ID),
          [DISABLED_ID]: samlInstance(DISABLED_ID),
          [OIDC_ID]: {
            module: 'oidc',
            conf: { clientSecret: PRIVATE_KEY },
            authorizationUrl: async () => 'https://provider.example/authorize'
          },
          [BROKEN_ID]: {
            module: 'saml',
            metadata() {
              throw new Error('ERR_STRATEGY_MISCONFIGURED')
            }
          },
          [CRASHING_ID]: {
            module: 'saml',
            metadata() {
              throw new Error('boom')
            }
          }
        }
      },
      sitesMappings: {}
    })

    app = await buildTestApp({ routes: authenticationRoutes, ajv: true })
  })

  after(async () => {
    await closeTestApp(app)
    wikiHandle.restore()
  })

  beforeEach(() => {
    metadataArgs = []
  })

  test('answers 200 XML for an enabled SAML strategy, built for the request host', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/auth/${SAML_ID}/metadata`,
      headers: { host: 'wiki.example.com' }
    })

    assert.equal(res.statusCode, 200)
    assert.match(String(res.headers['content-type']), /^application\/samlmetadata\+xml/)
    assert.deepEqual(metadataArgs, [`http://wiki.example.com/_api/auth/${SAML_ID}/callback`])
    assert.match(res.body, new RegExp(`entityID="urn:cardinal:${SAML_ID}"`))
    assert.match(
      res.body,
      new RegExp(`Location="http://wiki\\.example\\.com/_api/auth/${SAML_ID}/callback"`)
    )
  })

  test('is not refused by the login-attempt rate limit, however often it is fetched', async () => {
    for (let i = 0; i < 40; i++) {
      const res = await app.inject({ method: 'GET', url: `/auth/${SAML_ID}/metadata` })
      assert.equal(res.statusCode, 200)
    }
  })

  test('never puts the configured private key in the response', async () => {
    const res = await app.inject({ method: 'GET', url: `/auth/${SAML_ID}/metadata` })

    assert.equal(res.statusCode, 200)
    assert.doesNotMatch(res.body, /SECRETKEYMATERIAL/)
  })

  for (const [label, id] of [
    ['a disabled strategy', DISABLED_ID],
    ['an unknown strategy id', 'c9999999-9999-9999-9999-999999999999'],
    ['a strategy whose module has no metadata (OIDC)', OIDC_ID]
  ] as const) {
    test(`answers 404 for ${label}`, async () => {
      const res = await app.inject({ method: 'GET', url: `/auth/${id}/metadata` })

      assert.equal(res.statusCode, 404)
      assert.equal(res.json().message, 'There is no such login provider.')
      assert.deepEqual(metadataArgs, [])
      assert.doesNotMatch(res.body, /SECRETKEYMATERIAL/)
    })
  }

  test('a misconfigured strategy answers the same 404, without naming what is wrong', async () => {
    const res = await app.inject({ method: 'GET', url: `/auth/${BROKEN_ID}/metadata` })

    assert.equal(res.statusCode, 404)
    assert.equal(res.json().message, 'There is no such login provider.')
    assert.doesNotMatch(res.body, /MISCONFIGURED/)
  })

  test('an unexpected failure is not swallowed into a 404', async () => {
    const res = await app.inject({ method: 'GET', url: `/auth/${CRASHING_ID}/metadata` })

    assert.equal(res.statusCode, 500)
  })
})
