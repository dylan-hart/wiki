import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fastifySensible from '@fastify/sensible'
import { limitApiKey, limitApiRequests } from './rateLimit.ts'

/**
 * `limitApiKey` is the global per-key limiter wired into the onRequest API-key-auth hook in
 * `index.ts` (not a per-route hook like `limitAuthAttempts`/`limitRenders`), so it is exercised here
 * the way `api/apiKeys.test.ts` exercises route wiring: a real fastify instance with `@fastify/
 * sensible` registered (for the real `reply.tooManyRequests()`), `WIKI.models.rateLimits.consume`
 * stubbed so no database is touched, and an inline route standing in for "any `/_api/` route with a
 * verified key attached".
 */
describe('limitApiKey', () => {
  let consumeCalls: any[]
  let consumeResult: { allowed: boolean; hits: number; retryAfter: number }
  let app: FastifyInstance

  before(async () => {
    ;(globalThis as any).WIKI = {
      models: {
        rateLimits: {
          consume: async (key: string, policy: any) => {
            consumeCalls.push({ key, policy })
            return consumeResult
          }
        }
      },
      logger: {
        debug: () => {}
      }
    }

    app = fastify()
    await app.register(fastifySensible)
    app.get(
      '/probe',
      {
        preHandler: (req, _reply) => {
          ;(req as any).apiKey = { id: 'key-123', permissions: ['read:pages'] }
          return Promise.resolve()
        }
      },
      async (req, reply) => {
        await limitApiKey(req as any, reply)
        if (reply.sent) {
          return
        }
        return { ok: true }
      }
    )
    app.get(
      '/probe-admin-key',
      {
        preHandler: (req, _reply) => {
          ;(req as any).apiKey = { id: 'admin-key-456', permissions: ['manage:system'] }
          return Promise.resolve()
        }
      },
      async (req, reply) => {
        await limitApiKey(req as any, reply)
        if (reply.sent) {
          return
        }
        return { ok: true }
      }
    )
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  beforeEach(() => {
    consumeCalls = []
  })

  test('lets a request through and keys the counter by the api key id, not by ip', async () => {
    consumeResult = { allowed: true, hits: 1, retryAfter: 0 }
    const res = await app.inject({ method: 'GET', url: '/probe' })
    assert.equal(res.statusCode, 200)
    assert.equal(consumeCalls.length, 1)
    assert.equal(consumeCalls[0].key, 'apikey:key-123')
  })

  test('refuses with 429 and a Retry-After header once the key is banned', async () => {
    consumeResult = { allowed: false, hits: 301, retryAfter: 123 }
    const res = await app.inject({ method: 'GET', url: '/probe' })
    assert.equal(res.statusCode, 429)
    assert.equal(res.headers['retry-after'], '123')
  })

  test('does not exempt a key whose resolved permissions include manage:system', () => {
    return (async () => {
      consumeResult = { allowed: false, hits: 301, retryAfter: 60 }
      const res = await app.inject({ method: 'GET', url: '/probe-admin-key' })
      assert.equal(res.statusCode, 429)
      assert.equal(consumeCalls[0].key, 'apikey:admin-key-456')
    })()
  })
})

/**
 * Unit tests for `limitApiRequests` (task 635, feature 398): the general `/_api/*` rate-limit hook.
 *
 * `WIKI.models.rateLimits.consume` is stubbed rather than exercised against a real database — the
 * database-backed fixed-window logic itself belongs to `models/rateLimits.ts`, not this helper. What
 * this file covers is the hook's own job: which key it builds for a given request, which requests it
 * exempts, and how it turns a refused verdict into a 429 with `Retry-After` — matching
 * `limitAuthAttempts`/`limitRenders`'s existing shape.
 */
describe('limitApiRequests', () => {
  function makeReply(): FastifyReply {
    return {
      header: mock.fn(),
      tooManyRequests: mock.fn()
    } as unknown as FastifyReply
  }

  function makeReq(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
    return {
      method: 'GET',
      url: '/_api/pages',
      ip: '203.0.113.4',
      apiKey: null,
      session: undefined,
      ...overrides
    } as unknown as FastifyRequest
  }

  let consume: ReturnType<typeof mock.fn>

  beforeEach(() => {
    consume = mock.fn(async () => ({ allowed: true, hits: 1, retryAfter: 0 }))
    ;(globalThis as any).WIKI = {
      config: {
        security: {
          apiRateLimitEnabled: true,
          apiRateLimitMax: 300,
          apiRateLimitWindow: '5m',
          apiRateLimitBan: '15m'
        }
      },
      models: {
        rateLimits: { consume }
      },
      logger: { debug: mock.fn() }
    }
  })

  afterEach(() => {
    delete (globalThis as any).WIKI
  })

  test('keys by apiKey id when the request carries a verified API key', async () => {
    const req = makeReq({
      apiKey: {
        id: 'key-1',
        permissions: ['read:pages'],
        groupIds: [],
        scope: null,
        allowedClassifications: null,
        userId: null,
        siteId: null
      }
    })
    await limitApiRequests(req, makeReply())
    assert.equal(consume.mock.calls.length, 1)
    assert.equal(consume.mock.calls[0].arguments[0], 'api:apiKey:key-1')
  })

  test('keys by session user id when cookie-authenticated and no API key', async () => {
    const req = makeReq({
      session: { authenticated: true, user: { id: 'user-1' }, permissions: ['read:pages'] } as any
    })
    await limitApiRequests(req, makeReply())
    assert.equal(consume.mock.calls.length, 1)
    assert.equal(consume.mock.calls[0].arguments[0], 'api:user:user-1')
  })

  test('keys by IP when neither an API key nor an authenticated session is present', async () => {
    const req = makeReq()
    await limitApiRequests(req, makeReply())
    assert.equal(consume.mock.calls.length, 1)
    assert.equal(consume.mock.calls[0].arguments[0], 'api:ip:203.0.113.4')
  })

  test('prefers the API key over an authenticated session when both are present', async () => {
    const req = makeReq({
      apiKey: {
        id: 'key-1',
        permissions: ['read:pages'],
        groupIds: [],
        scope: null,
        allowedClassifications: null,
        userId: null,
        siteId: null
      },
      session: { authenticated: true, user: { id: 'user-1' }, permissions: ['read:pages'] } as any
    })
    await limitApiRequests(req, makeReply())
    assert.equal(consume.mock.calls[0].arguments[0], 'api:apiKey:key-1')
  })

  test('reads the configured policy from security.apiRateLimit* settings', async () => {
    ;(globalThis as any).WIKI.config.security = {
      apiRateLimitEnabled: true,
      apiRateLimitMax: 42,
      apiRateLimitWindow: '10m',
      apiRateLimitBan: '1h'
    }
    const req = makeReq()
    await limitApiRequests(req, makeReply())
    const policy = consume.mock.calls[0].arguments[1] as any
    assert.equal(policy.max, 42)
    assert.equal(policy.windowSeconds, 600)
    assert.equal(policy.banSeconds, 3600)
  })

  test('exempts manage:system granted through the API key', async () => {
    const req = makeReq({
      apiKey: {
        id: 'key-1',
        permissions: ['manage:system'],
        groupIds: [],
        scope: null,
        allowedClassifications: null,
        userId: null,
        siteId: null
      }
    })
    await limitApiRequests(req, makeReply())
    assert.equal(consume.mock.calls.length, 0)
  })

  test('exempts manage:system granted through the session', async () => {
    const req = makeReq({
      session: {
        authenticated: true,
        user: { id: 'user-1' },
        permissions: ['manage:system']
      } as any
    })
    await limitApiRequests(req, makeReply())
    assert.equal(consume.mock.calls.length, 0)
  })

  test('does nothing while apiRateLimitEnabled is false', async () => {
    ;(globalThis as any).WIKI.config.security.apiRateLimitEnabled = false
    const req = makeReq()
    const reply = makeReply()
    await limitApiRequests(req, reply)
    assert.equal(consume.mock.calls.length, 0)
    assert.equal((reply.tooManyRequests as any).mock.calls.length, 0)
  })

  test('refuses with a 429 and Retry-After once the policy is exceeded', async () => {
    consume.mock.mockImplementationOnce(async () => ({
      allowed: false,
      hits: 301,
      retryAfter: 120
    }))
    const req = makeReq()
    const reply = makeReply()
    await limitApiRequests(req, reply)
    assert.deepEqual((reply.header as any).mock.calls[0].arguments, ['Retry-After', '120'])
    assert.equal((reply.tooManyRequests as any).mock.calls.length, 1)
  })

  test('two different API keys get independent counters', async () => {
    // -> A stateful stand-in for `WIKI.models.rateLimits.consume`: a real per-key counter (not just a
    //    fixed verdict), so this exercises what the task asks for directly — that two different
    //    `req.apiKey.id` values never share a bucket — rather than just asserting the key strings
    //    differ (which the "keys by ..." tests above already do).
    const hits = new Map<string, number>()
    consume.mock.mockImplementation(async (key: string, policy: any) => {
      const n = (hits.get(key) ?? 0) + 1
      hits.set(key, n)
      return { allowed: n <= policy.max, hits: n, retryAfter: n <= policy.max ? 0 : 60 }
    })
    ;(globalThis as any).WIKI.config.security.apiRateLimitMax = 2

    const keyA = {
      id: 'key-a',
      permissions: [],
      groupIds: [],
      scope: null,
      allowedClassifications: null,
      userId: null,
      siteId: null
    }
    const keyB = {
      id: 'key-b',
      permissions: [],
      groupIds: [],
      scope: null,
      allowedClassifications: null,
      userId: null,
      siteId: null
    }

    // Exhaust key A's limit (2 allowed, 3rd refused).
    await limitApiRequests(makeReq({ apiKey: keyA }), makeReply())
    await limitApiRequests(makeReq({ apiKey: keyA }), makeReply())
    const replyA3 = makeReply()
    await limitApiRequests(makeReq({ apiKey: keyA }), replyA3)
    assert.equal((replyA3.tooManyRequests as any).mock.calls.length, 1)

    // Key B's first attempt is unaffected by A having just been refused.
    const replyB1 = makeReply()
    await limitApiRequests(makeReq({ apiKey: keyB }), replyB1)
    assert.equal((replyB1.tooManyRequests as any).mock.calls.length, 0)
  })

  test('an API key and an anonymous IP get independent counters', async () => {
    const hits = new Map<string, number>()
    consume.mock.mockImplementation(async (key: string, policy: any) => {
      const n = (hits.get(key) ?? 0) + 1
      hits.set(key, n)
      return { allowed: n <= policy.max, hits: n, retryAfter: n <= policy.max ? 0 : 60 }
    })
    ;(globalThis as any).WIKI.config.security.apiRateLimitMax = 2

    const apiKeyReq = () =>
      makeReq({
        apiKey: {
          id: 'key-a',
          permissions: [],
          groupIds: [],
          scope: null,
          allowedClassifications: null,
          userId: null,
          siteId: null
        }
      })
    const anonReq = () => makeReq({ ip: '203.0.113.4' })

    // Exhaust the API key's limit.
    await limitApiRequests(apiKeyReq(), makeReply())
    await limitApiRequests(apiKeyReq(), makeReply())
    const replyKey3 = makeReply()
    await limitApiRequests(apiKeyReq(), replyKey3)
    assert.equal((replyKey3.tooManyRequests as any).mock.calls.length, 1)

    // The same-looking anonymous caller (no API key) is on its own counter and unaffected.
    const replyAnon1 = makeReply()
    await limitApiRequests(anonReq(), replyAnon1)
    assert.equal((replyAnon1.tooManyRequests as any).mock.calls.length, 0)
  })

  test('does not build the same key as limitAuthAttempts, so the two never share a counter', async () => {
    // -> `limitAuthAttempts` consumes `auth:<ip>`; confirms this hook's IP-keyed bucket is namespaced
    //    differently, so applying both to an auth endpoint never double-counts one attempt against a
    //    single counter. See the rationale in `helpers/rateLimit.ts#limitApiRequests`.
    const req = makeReq({ ip: '203.0.113.9' })
    await limitApiRequests(req, makeReply())
    const key = consume.mock.calls[0].arguments[0]
    assert.notEqual(key, `auth:203.0.113.9`)
    assert.equal(key, 'api:ip:203.0.113.9')
  })
})
