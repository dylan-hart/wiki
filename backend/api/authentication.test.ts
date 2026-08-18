import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import fastifyFormBody from '@fastify/formbody'
import ajvFormats from 'ajv-formats'
import authenticationRoutes from './authentication.ts'
import { registerSchemas as registerAuthSchema } from './schemas/authentication.ts'

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

const STRATEGY_ID = 'a1111111-1111-1111-1111-111111111111'

let app: FastifyInstance
let session: Record<string, any>
let loginCalls: any[]

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
})

before(async () => {
  loginCalls = []
  ;(globalThis as any).WIKI = {
    config: { security: { authRateLimitEnabled: false } },
    models: {
      flags: { authDebug: () => {} },
      authentication: {
        getStrategyById: async (id: string) =>
          id === STRATEGY_ID
            ? { id: STRATEGY_ID, module: 'saml', isEnabled: true, registration: true }
            : null
      },
      users: {
        loginWithProvider: async (args: any) => {
          loginCalls.push(args)
          return { authenticated: true, nextAction: 'redirect', redirect: '/welcome' }
        }
      }
    },
    auth: {
      strategies: {
        [STRATEGY_ID]: {
          module: 'saml',
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
  await registerAuthSchema(app)
  // -> No @fastify/session in this unit test: the session is a plain object this suite controls
  //    directly, swapped out per test, standing in for what the real plugin decorates onto the request.
  app.addHook('onRequest', async (req) => {
    ;(req as any).session = session
  })
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
