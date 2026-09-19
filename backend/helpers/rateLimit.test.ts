import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fastifySensible from '@fastify/sensible'
import {
  activeBanMemo,
  consumeAccountAuthAttempt,
  enforceCommentCooldown,
  isPublicRateLimitedPath,
  limitApiKey,
  limitAuthAttempts,
  limitApiRequests,
  limitGuestComments,
  limitPublicRequests,
  limitRenders,
  limitUploads
} from './rateLimit.ts'
import { resetCoalesce } from './logCoalesce.ts'
import { makeReplyStub, makeRequestStub } from '../test/fastify.ts'
import { installTestWiki } from '../test/mocks.ts'

let wikiHandle: { restore(): void }

describe('limitApiKey', () => {
  let consumeCalls: any[]
  let consumeResult: { allowed: boolean; hits: number; retryAfter: number }
  let app: FastifyInstance
  let warn: ReturnType<typeof mock.fn>

  before(async () => {
    warn = mock.fn()
    wikiHandle = installTestWiki({
      models: {
        rateLimits: {
          consume: async (key: string, policy: any) => {
            consumeCalls.push({ key, policy })
            return consumeResult
          }
        }
      },
      logger: {
        warn,
        debug: () => {}
      }
    })

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
    wikiHandle.restore()
  })

  beforeEach(() => {
    consumeCalls = []
    warn.mock.resetCalls()
    // -> Both are module-level state shared across this file: a ban or a pending summary window
    //    left by one case must not leak into the next one reusing the same key.
    activeBanMemo.clear()
    resetCoalesce()
  })

  afterEach(() => {
    resetCoalesce()
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

  test('folds a burst of refusals into threshold individual lines and one summary carrying the count', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    consumeResult = { allowed: false, hits: 301, retryAfter: 120 }

    for (let i = 0; i < 20; i += 1) {
      activeBanMemo.clear()
      await app.inject({ method: 'GET', url: '/probe' })
    }
    assert.equal(warn.mock.calls.length, 3, 'twenty refusals, three individual lines')

    // -> `API_KEY_LIMIT.windowSeconds` is a fixed 300s, not admin-configurable.
    mock.timers.tick(300_000)
    assert.equal(warn.mock.calls.length, 4)
    const [, message, fields] = warn.mock.calls[3].arguments
    assert.equal(message, 'rate limit refused 20 times in 300s')
    assert.deepEqual(fields, { apiKey: 'key-123', count: 20 })
    mock.timers.reset()
  })
})

describe('limitApiRequests', () => {
  const makeReply = (): FastifyReply => makeReplyStub().reply

  const makeReq = (overrides: Partial<FastifyRequest> = {}): FastifyRequest =>
    makeRequestStub(overrides)

  let consume: ReturnType<typeof mock.fn>
  let warn: ReturnType<typeof mock.fn>

  beforeEach(() => {
    consume = mock.fn(async () => ({ allowed: true, hits: 1, retryAfter: 0 }))
    warn = mock.fn()
    activeBanMemo.clear()
    resetCoalesce()
    wikiHandle = installTestWiki({
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
      logger: { warn, debug: mock.fn() }
    })
  })

  afterEach(() => {
    resetCoalesce()
    wikiHandle.restore()
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
    ;(globalThis as any).CARDINAL.config.security = {
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
    ;(globalThis as any).CARDINAL.config.security.apiRateLimitEnabled = false
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
    // -> A real per-key counter rather than a fixed verdict, so this shows the buckets are separate
    //    and not merely that the key strings differ.
    const hits = new Map<string, number>()
    consume.mock.mockImplementation(async (key: string, policy: any) => {
      const n = (hits.get(key) ?? 0) + 1
      hits.set(key, n)
      return { allowed: n <= policy.max, hits: n, retryAfter: n <= policy.max ? 0 : 60 }
    })
    ;(globalThis as any).CARDINAL.config.security.apiRateLimitMax = 2

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

    await limitApiRequests(makeReq({ apiKey: keyA }), makeReply())
    await limitApiRequests(makeReq({ apiKey: keyA }), makeReply())
    const replyA3 = makeReply()
    await limitApiRequests(makeReq({ apiKey: keyA }), replyA3)
    assert.equal((replyA3.tooManyRequests as any).mock.calls.length, 1)

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
    ;(globalThis as any).CARDINAL.config.security.apiRateLimitMax = 2

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

    await limitApiRequests(apiKeyReq(), makeReply())
    await limitApiRequests(apiKeyReq(), makeReply())
    const replyKey3 = makeReply()
    await limitApiRequests(apiKeyReq(), replyKey3)
    assert.equal((replyKey3.tooManyRequests as any).mock.calls.length, 1)

    const replyAnon1 = makeReply()
    await limitApiRequests(anonReq(), replyAnon1)
    assert.equal((replyAnon1.tooManyRequests as any).mock.calls.length, 0)
  })

  test('does not build the same key as limitAuthAttempts, so the two never share a counter', async () => {
    // -> `limitAuthAttempts` consumes `auth:<ip>`, and both hooks run on an auth endpoint.
    const req = makeReq({ ip: '203.0.113.9' })
    await limitApiRequests(req, makeReply())
    const key = consume.mock.calls[0].arguments[0]
    assert.notEqual(key, `auth:203.0.113.9`)
    assert.equal(key, 'api:ip:203.0.113.9')
  })

  test('folds a burst of refusals into threshold individual lines and one summary carrying the count', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    consume.mock.mockImplementation(async () => ({ allowed: false, hits: 301, retryAfter: 120 }))

    for (let i = 0; i < 20; i += 1) {
      await limitApiRequests(makeReq({ ip: '203.0.113.9' }), makeReply())
    }
    assert.equal(warn.mock.calls.length, 3, 'twenty refusals, three individual lines')

    // -> `apiRateLimitWindow: '5m'` above is the window the summary closes on.
    mock.timers.tick(300_000)
    assert.equal(warn.mock.calls.length, 4)
    const [, message, fields] = warn.mock.calls[3].arguments
    assert.equal(message, 'rate limit refused 20 times in 300s')
    assert.deepEqual(fields, { key: 'ip:203.0.113.9', count: 20 })
    mock.timers.reset()
  })
})

/**
 * `consumeAccountAuthAttempt` takes no `req.ip` at all, so bounding guesses across differing
 * addresses is inherent to its signature rather than something a test builds addresses to observe.
 */
describe('consumeAccountAuthAttempt', () => {
  let consume: ReturnType<typeof mock.fn>

  beforeEach(() => {
    consume = mock.fn(async () => ({ allowed: true, hits: 1, retryAfter: 0 }))
    wikiHandle = installTestWiki({
      config: {
        security: {
          authRateLimitEnabled: true,
          authRateLimitMax: 10,
          authRateLimitWindow: '5m',
          authRateLimitBan: '15m'
        }
      },
      models: {
        rateLimits: { consume }
      }
    })
  })

  afterEach(() => {
    wikiHandle.restore()
  })

  test('keys by the account identifier, namespaced apart from the IP-keyed auth: bucket', async () => {
    await consumeAccountAuthAttempt('person@example.com')
    assert.equal(consume.mock.calls.length, 1)
    assert.equal(consume.mock.calls[0].arguments[0], 'auth:user:person@example.com')
  })

  test('normalizes the identifier (trims and lower-cases) so casing/whitespace do not split the bucket', async () => {
    await consumeAccountAuthAttempt('  Person@Example.com  ')
    assert.equal(consume.mock.calls[0].arguments[0], 'auth:user:person@example.com')
  })

  test('reads the configured policy from security.authRateLimit* settings', async () => {
    ;(globalThis as any).CARDINAL.config.security = {
      authRateLimitEnabled: true,
      authRateLimitMax: 5,
      authRateLimitWindow: '2m',
      authRateLimitBan: '10m'
    }
    await consumeAccountAuthAttempt('person@example.com')
    const policy = consume.mock.calls[0].arguments[1] as any
    assert.equal(policy.max, 5)
    assert.equal(policy.windowSeconds, 120)
    assert.equal(policy.banSeconds, 600)
  })

  test('does nothing (always allowed, no consume call) while authRateLimitEnabled is false', async () => {
    ;(globalThis as any).CARDINAL.config.security.authRateLimitEnabled = false
    const verdict = await consumeAccountAuthAttempt('person@example.com')
    assert.equal(verdict.allowed, true)
    assert.equal(consume.mock.calls.length, 0)
  })

  test('repeated attempts against one account are refused once the policy limit is reached, regardless of what req.ip each attempt would have carried', async () => {
    const hits = new Map<string, number>()
    consume.mock.mockImplementation(async (key: string, policy: any) => {
      const n = (hits.get(key) ?? 0) + 1
      hits.set(key, n)
      return { allowed: n <= policy.max, hits: n, retryAfter: n <= policy.max ? 0 : 60 }
    })
    ;(globalThis as any).CARDINAL.config.security.authRateLimitMax = 3

    for (let i = 0; i < 3; i++) {
      const verdict = await consumeAccountAuthAttempt('victim@example.com')
      assert.equal(verdict.allowed, true)
    }
    const fourth = await consumeAccountAuthAttempt('victim@example.com')
    assert.equal(fourth.allowed, false)
  })

  test("a second account's attempts are unaffected by the first account being exhausted", async () => {
    const hits = new Map<string, number>()
    consume.mock.mockImplementation(async (key: string, policy: any) => {
      const n = (hits.get(key) ?? 0) + 1
      hits.set(key, n)
      return { allowed: n <= policy.max, hits: n, retryAfter: n <= policy.max ? 0 : 60 }
    })
    ;(globalThis as any).CARDINAL.config.security.authRateLimitMax = 1

    const first = await consumeAccountAuthAttempt('victim@example.com')
    assert.equal(first.allowed, true)
    const second = await consumeAccountAuthAttempt('victim@example.com')
    assert.equal(second.allowed, false)

    const otherAccount = await consumeAccountAuthAttempt('someone-else@example.com')
    assert.equal(otherAccount.allowed, true)
  })
})

describe('isPublicRateLimitedPath', () => {
  test('matches the two bare root files exactly', () => {
    assert.equal(isPublicRateLimitedPath('/sitemap.xml'), true)
    assert.equal(isPublicRateLimitedPath('/robots.txt'), true)
  })

  test('matches a route under each prefixed public controller', () => {
    assert.equal(isPublicRateLimitedPath('/_icons/mdi.json'), true)
    assert.equal(isPublicRateLimitedPath('/_icons/mdi/account.svg'), true)
    assert.equal(isPublicRateLimitedPath('/_files/some-asset.png'), true)
    assert.equal(isPublicRateLimitedPath('/_thumb/some-page/thumb.png'), true)
    assert.equal(isPublicRateLimitedPath('/_site/logo'), true)
  })

  test('does not match /_api/, an unrelated root path, or a bare prefix with nothing after it', () => {
    assert.equal(isPublicRateLimitedPath('/_api/pages'), false)
    assert.equal(isPublicRateLimitedPath('/'), false)
    assert.equal(isPublicRateLimitedPath('/login'), false)
    assert.equal(isPublicRateLimitedPath('/_icons'), false)
  })
})

describe('limitPublicRequests', () => {
  const makeReply = (): FastifyReply => makeReplyStub().reply

  const makeReq = (overrides: Partial<FastifyRequest> = {}): FastifyRequest =>
    makeRequestStub({ url: '/sitemap.xml', ...overrides })

  let consume: ReturnType<typeof mock.fn>
  let warn: ReturnType<typeof mock.fn>

  beforeEach(() => {
    consume = mock.fn(async () => ({ allowed: true, hits: 1, retryAfter: 0 }))
    warn = mock.fn()
    resetCoalesce()
    wikiHandle = installTestWiki({
      config: { security: { apiRateLimitEnabled: true } },
      models: { rateLimits: { consume } },
      logger: { warn, debug: mock.fn() }
    })
  })

  afterEach(() => {
    resetCoalesce()
    wikiHandle.restore()
  })

  test('keys by ip for an anonymous request', async () => {
    await limitPublicRequests(makeReq(), makeReply())
    assert.equal(consume.mock.calls.length, 1)
    assert.equal(consume.mock.calls[0].arguments[0], 'public:ip:203.0.113.4')
  })

  test('keys by session user id when cookie-authenticated', async () => {
    const req = makeReq({
      session: { authenticated: true, user: { id: 'user-1' }, permissions: ['read:pages'] } as any
    })
    await limitPublicRequests(req, makeReply())
    assert.equal(consume.mock.calls[0].arguments[0], 'public:user:user-1')
  })

  test('never builds an api: key, so it can never share a bucket with limitApiRequests', async () => {
    await limitPublicRequests(makeReq(), makeReply())
    const key = consume.mock.calls[0].arguments[0] as string
    assert.ok(key.startsWith('public:'))
    assert.ok(!key.startsWith('api:'))
  })

  test('exempts a session carrying manage:system', async () => {
    const req = makeReq({
      session: {
        authenticated: true,
        user: { id: 'admin-1' },
        permissions: ['manage:system']
      } as any
    })
    await limitPublicRequests(req, makeReply())
    assert.equal(consume.mock.calls.length, 0)
  })

  test('does nothing while apiRateLimitEnabled is false, the same shared toggle limitApiRequests uses', async () => {
    ;(globalThis as any).CARDINAL.config.security.apiRateLimitEnabled = false
    const reply = makeReply()
    await limitPublicRequests(makeReq(), reply)
    assert.equal(consume.mock.calls.length, 0)
    assert.equal((reply.tooManyRequests as any).mock.calls.length, 0)
  })

  test('refuses with a 429 and Retry-After once the policy is exceeded', async () => {
    consume.mock.mockImplementationOnce(async () => ({
      allowed: false,
      hits: 601,
      retryAfter: 90
    }))
    const reply = makeReply()
    await limitPublicRequests(makeReq(), reply)
    assert.deepEqual((reply.header as any).mock.calls[0].arguments, ['Retry-After', '90'])
    assert.equal((reply.tooManyRequests as any).mock.calls.length, 1)
  })

  test('an anonymous /_api/ caller and an anonymous public-route caller get independent counters', async () => {
    // -> The `/_api/` side is the one exhausted because only its max is configurable; the public
    //    policy is the fixed `PUBLIC_DEFAULTS`.
    const hits = new Map<string, number>()
    consume.mock.mockImplementation(async (key: string, policy: any) => {
      const n = (hits.get(key) ?? 0) + 1
      hits.set(key, n)
      return { allowed: n <= policy.max, hits: n, retryAfter: n <= policy.max ? 0 : 60 }
    })
    ;(globalThis as any).CARDINAL.config.security = {
      apiRateLimitEnabled: true,
      apiRateLimitMax: 2
    }

    const apiReq = {
      method: 'GET',
      url: '/_api/pages',
      ip: '203.0.113.4',
      apiKey: null,
      session: undefined
    } as unknown as FastifyRequest
    await limitApiRequests(apiReq, makeReply())
    await limitApiRequests(apiReq, makeReply())
    const replyApi3 = makeReply()
    await limitApiRequests(apiReq, replyApi3)
    assert.equal((replyApi3.tooManyRequests as any).mock.calls.length, 1)

    const replyPublic1 = makeReply()
    await limitPublicRequests(makeReq(), replyPublic1)
    assert.equal((replyPublic1.tooManyRequests as any).mock.calls.length, 0)
  })

  test('folds a burst of refusals into threshold individual lines and one summary carrying the count', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    consume.mock.mockImplementation(async () => ({ allowed: false, hits: 601, retryAfter: 90 }))

    for (let i = 0; i < 20; i += 1) {
      await limitPublicRequests(makeReq(), makeReply())
    }
    assert.equal(warn.mock.calls.length, 3, 'twenty refusals, three individual lines')

    // -> `PUBLIC_DEFAULTS.windowSeconds` is a fixed 300s, not admin-configurable.
    mock.timers.tick(300_000)
    assert.equal(warn.mock.calls.length, 4)
    const [, message, fields] = warn.mock.calls[3].arguments
    assert.equal(message, 'rate limit refused 20 times in 300s')
    assert.deepEqual(fields, { key: 'ip:203.0.113.4', count: 20 })
    mock.timers.reset()
  })
})

/**
 * Exercised through `limitApiRequests`, but the shared `consumeWithBanMemo` wrapper is what is under
 * test, not anything specific to that hook.
 */
describe('rate-limit ban memo', () => {
  const makeReply = (): FastifyReply => makeReplyStub().reply

  const makeReq = (overrides: Partial<FastifyRequest> = {}): FastifyRequest =>
    makeRequestStub({ ip: '198.51.100.7', ...overrides })

  let consume: ReturnType<typeof mock.fn>

  beforeEach(() => {
    consume = mock.fn(async () => ({ allowed: true, hits: 1, retryAfter: 0 }))
    activeBanMemo.clear()
    wikiHandle = installTestWiki({
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
    })
  })

  afterEach(() => {
    wikiHandle.restore()
  })

  test('a second request from an already-banned key is refused with no consume() call reaching the database', async () => {
    consume.mock.mockImplementationOnce(async () => ({
      allowed: false,
      hits: 301,
      retryAfter: 120
    }))
    const req = makeReq()

    const reply1 = makeReply()
    await limitApiRequests(req, reply1)
    assert.equal(consume.mock.calls.length, 1)
    assert.equal((reply1.tooManyRequests as any).mock.calls.length, 1)
    assert.deepEqual((reply1.header as any).mock.calls[0].arguments, ['Retry-After', '120'])

    const reply2 = makeReply()
    await limitApiRequests(makeReq(), reply2)
    assert.equal(consume.mock.calls.length, 1)
    assert.equal((reply2.tooManyRequests as any).mock.calls.length, 1)
  })

  test('a permitted request always goes to SQL, even repeatedly, since a grant is never memoized', async () => {
    consume.mock.mockImplementation(async () => ({ allowed: true, hits: 1, retryAfter: 0 }))
    const req = makeReq()

    await limitApiRequests(req, makeReply())
    await limitApiRequests(makeReq(), makeReply())
    await limitApiRequests(makeReq(), makeReply())

    assert.equal(consume.mock.calls.length, 3)
  })

  /**
   * `lru-cache` tracks TTL against `performance.now()`, which `node:test`'s `mock.timers` does not
   * fake, so advancing a mocked `Date` would not move the memo's clock. Faking `performance.now()`
   * itself does.
   */
  function withFakePerfNow(startMs: number) {
    let now = startMs
    const mocked = mock.method(performance, 'now', () => now)
    return {
      advance: (ms: number) => {
        now += ms
      },
      restore: () => mocked.mock.restore()
    }
  }

  test('a memoized ban expires exactly when its own retryAfter elapses', async () => {
    const clock = withFakePerfNow(1_700_000_000_000)
    try {
      consume.mock.mockImplementationOnce(async () => ({
        allowed: false,
        hits: 301,
        retryAfter: 5
      }))
      await limitApiRequests(makeReq(), makeReply())
      assert.equal(consume.mock.calls.length, 1)

      const replyStillBanned = makeReply()
      await limitApiRequests(makeReq(), replyStillBanned)
      assert.equal(consume.mock.calls.length, 1)
      assert.equal((replyStillBanned.tooManyRequests as any).mock.calls.length, 1)

      clock.advance(5_001)
      consume.mock.mockImplementationOnce(async () => ({ allowed: true, hits: 1, retryAfter: 0 }))
      const replyAfterExpiry = makeReply()
      await limitApiRequests(makeReq(), replyAfterExpiry)

      assert.equal(consume.mock.calls.length, 2)
      assert.equal((replyAfterExpiry.tooManyRequests as any).mock.calls.length, 0)
    } finally {
      clock.restore()
    }
  })

  test('retryAfter reported from the memo counts down rather than staying pinned at the original value', async () => {
    const clock = withFakePerfNow(1_700_000_000_000)
    try {
      consume.mock.mockImplementationOnce(async () => ({
        allowed: false,
        hits: 301,
        retryAfter: 10
      }))
      await limitApiRequests(makeReq(), makeReply())

      clock.advance(4_000)
      const reply = makeReply()
      await limitApiRequests(makeReq(), reply)
      assert.equal(consume.mock.calls.length, 1)
      assert.deepEqual((reply.header as any).mock.calls[0].arguments, ['Retry-After', '6'])
    } finally {
      clock.restore()
    }
  })
})

describe('limitRenders', () => {
  const makeReply = (): FastifyReply => makeReplyStub().reply

  const makeReq = (overrides: Partial<FastifyRequest> = {}): FastifyRequest =>
    makeRequestStub({ method: 'GET', url: '/_render/page-1', ip: '203.0.113.9', ...overrides })

  let consume: ReturnType<typeof mock.fn>
  let warn: ReturnType<typeof mock.fn>

  beforeEach(() => {
    consume = mock.fn(async () => ({ allowed: true, hits: 1, retryAfter: 0 }))
    warn = mock.fn()
    activeBanMemo.clear()
    resetCoalesce()
    wikiHandle = installTestWiki({
      models: { rateLimits: { consume } },
      logger: { warn, debug: mock.fn() }
    })
  })

  afterEach(() => {
    resetCoalesce()
    wikiHandle.restore()
  })

  test('keys by session user id when authenticated, falling back to ip otherwise', async () => {
    await limitRenders(makeReq(), makeReply())
    assert.equal(consume.mock.calls[0].arguments[0], 'render:203.0.113.9')

    const req = makeReq({
      session: { authenticated: true, user: { id: 'user-1' }, permissions: [] } as any
    })
    await limitRenders(req, makeReply())
    assert.equal(consume.mock.calls[1].arguments[0], 'render:user-1')
  })

  test('exempts a session carrying manage:system', async () => {
    const req = makeReq({
      session: {
        authenticated: true,
        user: { id: 'admin-1' },
        permissions: ['manage:system']
      } as any
    })
    await limitRenders(req, makeReply())
    assert.equal(consume.mock.calls.length, 0)
  })

  test('refuses with a 429 and Retry-After once the policy is exceeded', async () => {
    consume.mock.mockImplementationOnce(async () => ({ allowed: false, hits: 11, retryAfter: 90 }))
    const reply = makeReply()
    await limitRenders(makeReq(), reply)
    assert.deepEqual((reply.header as any).mock.calls[0].arguments, ['Retry-After', '90'])
    assert.equal((reply.tooManyRequests as any).mock.calls.length, 1)
  })

  test('folds a burst of refusals into threshold individual lines and one summary carrying the count', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    consume.mock.mockImplementation(async () => ({ allowed: false, hits: 11, retryAfter: 90 }))

    for (let i = 0; i < 20; i += 1) {
      activeBanMemo.clear()
      await limitRenders(makeReq(), makeReply())
    }
    assert.equal(warn.mock.calls.length, 3, 'twenty refusals, three individual lines')

    // -> `RENDER_LIMIT.windowSeconds` is a fixed 300s, not admin-configurable.
    mock.timers.tick(300_000)
    assert.equal(warn.mock.calls.length, 4)
    const [, message, fields] = warn.mock.calls[3].arguments
    assert.equal(message, 'rate limit refused 20 times in 300s')
    assert.deepEqual(fields, { ip: '203.0.113.9', count: 20 })
    mock.timers.reset()
  })
})

describe('limitUploads', () => {
  const makeReply = (): FastifyReply => makeReplyStub().reply

  const makeReq = (overrides: Partial<FastifyRequest> = {}): FastifyRequest =>
    makeRequestStub({
      method: 'POST',
      url: '/sites/site-1/assets',
      ip: '203.0.113.11',
      ...overrides
    })

  let consume: ReturnType<typeof mock.fn>
  let warn: ReturnType<typeof mock.fn>

  beforeEach(() => {
    consume = mock.fn(async () => ({ allowed: true, hits: 1, retryAfter: 0 }))
    warn = mock.fn()
    activeBanMemo.clear()
    resetCoalesce()
    wikiHandle = installTestWiki({
      models: { rateLimits: { consume } },
      logger: { warn, debug: mock.fn() }
    })
  })

  afterEach(() => {
    resetCoalesce()
    wikiHandle.restore()
  })

  test('keys by session user id when authenticated, falling back to ip otherwise', async () => {
    await limitUploads(makeReq(), makeReply())
    assert.equal(consume.mock.calls[0].arguments[0], 'upload:203.0.113.11')

    const req = makeReq({
      session: { authenticated: true, user: { id: 'user-1' }, permissions: [] } as any
    })
    await limitUploads(req, makeReply())
    assert.equal(consume.mock.calls[1].arguments[0], 'upload:user-1')
  })

  test('exempts a session carrying manage:system', async () => {
    const req = makeReq({
      session: {
        authenticated: true,
        user: { id: 'admin-1' },
        permissions: ['manage:system']
      } as any
    })
    await limitUploads(req, makeReply())
    assert.equal(consume.mock.calls.length, 0)
  })

  test('refuses with a 429 and Retry-After once the policy is exceeded', async () => {
    consume.mock.mockImplementationOnce(async () => ({ allowed: false, hits: 21, retryAfter: 45 }))
    const reply = makeReply()
    await limitUploads(makeReq(), reply)
    assert.deepEqual((reply.header as any).mock.calls[0].arguments, ['Retry-After', '45'])
    assert.equal((reply.tooManyRequests as any).mock.calls.length, 1)
  })

  test('folds a burst of refusals into threshold individual lines and one summary carrying the count', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    consume.mock.mockImplementation(async () => ({ allowed: false, hits: 21, retryAfter: 45 }))

    for (let i = 0; i < 20; i += 1) {
      activeBanMemo.clear()
      await limitUploads(makeReq(), makeReply())
    }
    assert.equal(warn.mock.calls.length, 3, 'twenty refusals, three individual lines')

    // -> The upload limiter's windowSeconds is a fixed 300s, not admin-configurable.
    mock.timers.tick(300_000)
    assert.equal(warn.mock.calls.length, 4)
    const [, message, fields] = warn.mock.calls[3].arguments
    assert.equal(message, 'rate limit refused an upload 20 times in 300s')
    assert.deepEqual(fields, { key: '203.0.113.11', count: 20 })
    mock.timers.reset()
  })
})

describe('limitGuestComments', () => {
  const makeReply = (): FastifyReply => makeReplyStub().reply

  const makeReq = (overrides: Partial<FastifyRequest> = {}): FastifyRequest =>
    makeRequestStub({
      method: 'POST',
      url: '/_api/sites/site-1/pages/page-1/comments',
      ip: '203.0.113.7',
      ...overrides
    })

  let consume: ReturnType<typeof mock.fn>
  let warn: ReturnType<typeof mock.fn>

  beforeEach(() => {
    consume = mock.fn(async () => ({ allowed: true, hits: 1, retryAfter: 0 }))
    warn = mock.fn()
    resetCoalesce()
    wikiHandle = installTestWiki({
      models: { rateLimits: { consume } },
      logger: { warn, debug: mock.fn() }
    })
  })

  afterEach(() => {
    resetCoalesce()
    wikiHandle.restore()
  })

  test('keys the bucket by req.ip, prefixed so it never collides with another limiter', async () => {
    await limitGuestComments(makeReq(), makeReply())
    assert.equal(consume.mock.calls.length, 1)
    assert.equal(consume.mock.calls[0].arguments[0], 'comment-guest:203.0.113.7')
  })

  test('uses a fixed policy: 5 per 10 minutes, 15 minute ban', async () => {
    await limitGuestComments(makeReq(), makeReply())
    const policy = consume.mock.calls[0].arguments[1] as any
    assert.equal(policy.max, 5)
    assert.equal(policy.windowSeconds, 600)
    assert.equal(policy.banSeconds, 900)
  })

  test('lets the request through when under the limit', async () => {
    const reply = makeReply()
    await limitGuestComments(makeReq(), reply)
    assert.equal((reply.tooManyRequests as any).mock.calls.length, 0)
  })

  test('refuses with a 429 and Retry-After once the policy is exceeded', async () => {
    consume.mock.mockImplementationOnce(async () => ({ allowed: false, hits: 6, retryAfter: 120 }))
    const reply = makeReply()
    await limitGuestComments(makeReq(), reply)
    assert.deepEqual((reply.header as any).mock.calls[0].arguments, ['Retry-After', '120'])
    assert.equal((reply.tooManyRequests as any).mock.calls.length, 1)
  })

  test('two different guest addresses get independent counters', async () => {
    const hits = new Map<string, number>()
    consume.mock.mockImplementation(async (key: string, policy: any) => {
      const n = (hits.get(key) ?? 0) + 1
      hits.set(key, n)
      return { allowed: n <= policy.max, hits: n, retryAfter: n <= policy.max ? 0 : 60 }
    })

    for (let i = 0; i < 5; i++) {
      await limitGuestComments(makeReq({ ip: '203.0.113.7' }), makeReply())
    }
    const replySixth = makeReply()
    await limitGuestComments(makeReq({ ip: '203.0.113.7' }), replySixth)
    assert.equal((replySixth.tooManyRequests as any).mock.calls.length, 1)

    const replyOther = makeReply()
    await limitGuestComments(makeReq({ ip: '198.51.100.2' }), replyOther)
    assert.equal((replyOther.tooManyRequests as any).mock.calls.length, 0)
  })

  test('folds a burst of refusals into threshold individual lines and one summary carrying the count', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    consume.mock.mockImplementation(async () => ({ allowed: false, hits: 6, retryAfter: 120 }))

    for (let i = 0; i < 20; i += 1) {
      await limitGuestComments(makeReq(), makeReply())
    }
    assert.equal(warn.mock.calls.length, 3, 'twenty refusals, three individual lines')

    // -> `COMMENT_GUEST_LIMIT.windowSeconds` is a fixed 600s, not admin-configurable.
    mock.timers.tick(600_000)
    assert.equal(warn.mock.calls.length, 4)
    const [, message, fields] = warn.mock.calls[3].arguments
    assert.equal(message, 'rate limit refused a guest comment 20 times in 600s')
    assert.deepEqual(fields, { ip: '203.0.113.7', count: 20 })
    mock.timers.reset()
  })
})

describe('enforceCommentCooldown', () => {
  const makeReply = (): FastifyReply => makeReplyStub().reply

  const makeReq = (overrides: Partial<FastifyRequest> = {}): FastifyRequest =>
    makeRequestStub({
      method: 'POST',
      url: '/_api/sites/site-1/pages/page-1/comments',
      ip: '203.0.113.7',
      ...overrides
    })

  let consume: ReturnType<typeof mock.fn>
  let warn: ReturnType<typeof mock.fn>

  beforeEach(() => {
    consume = mock.fn(async () => ({ allowed: true, hits: 1, retryAfter: 0 }))
    warn = mock.fn()
    resetCoalesce()
    wikiHandle = installTestWiki({
      models: { rateLimits: { consume } },
      logger: { warn, debug: mock.fn() }
    })
  })

  afterEach(() => {
    resetCoalesce()
    wikiHandle.restore()
  })

  test('keys the bucket with a comment-cooldown: prefix around the caller-resolved bucketKey', async () => {
    await enforceCommentCooldown(makeReq(), makeReply(), 'user-42', 30)
    assert.equal(consume.mock.calls.length, 1)
    assert.equal(consume.mock.calls[0].arguments[0], 'comment-cooldown:user-42')
  })

  test('pools every guest onto whatever bucketKey the caller passes, e.g. "guests"', async () => {
    await enforceCommentCooldown(makeReq(), makeReply(), 'guests', 30)
    assert.equal(consume.mock.calls[0].arguments[0], 'comment-cooldown:guests')
  })

  test('builds a max:1 policy off the given minDelaySeconds, with banSeconds equal to it (not 0)', async () => {
    await enforceCommentCooldown(makeReq(), makeReply(), 'user-42', 45)
    const policy = consume.mock.calls[0].arguments[1] as any
    assert.equal(policy.max, 1)
    assert.equal(policy.windowSeconds, 45)
    assert.equal(policy.banSeconds, 45)
  })

  test('lets the request through when the verdict allows it', async () => {
    const reply = makeReply()
    await enforceCommentCooldown(makeReq(), reply, 'user-42', 30)
    assert.equal((reply.tooManyRequests as any).mock.calls.length, 0)
  })

  test('refuses with a 429 and Retry-After once the verdict refuses', async () => {
    consume.mock.mockImplementationOnce(async () => ({ allowed: false, hits: 2, retryAfter: 30 }))
    const reply = makeReply()
    await enforceCommentCooldown(makeReq(), reply, 'user-42', 30)
    assert.deepEqual((reply.header as any).mock.calls[0].arguments, ['Retry-After', '30'])
    assert.equal((reply.tooManyRequests as any).mock.calls.length, 1)
  })

  test('a user bucket and the pooled guests bucket count independently', async () => {
    const hits = new Map<string, number>()
    consume.mock.mockImplementation(async (key: string, policy: any) => {
      const n = (hits.get(key) ?? 0) + 1
      hits.set(key, n)
      return {
        allowed: n <= policy.max,
        hits: n,
        retryAfter: n <= policy.max ? 0 : policy.windowSeconds
      }
    })

    const replyFirst = makeReply()
    await enforceCommentCooldown(makeReq(), replyFirst, 'user-42', 30)
    assert.equal((replyFirst.tooManyRequests as any).mock.calls.length, 0)

    const replySecond = makeReply()
    await enforceCommentCooldown(makeReq(), replySecond, 'user-42', 30)
    assert.equal(
      (replySecond.tooManyRequests as any).mock.calls.length,
      1,
      'a second post inside minDelay from the same account is refused'
    )

    const replyGuest = makeReply()
    await enforceCommentCooldown(makeReq(), replyGuest, 'guests', 30)
    assert.equal(
      (replyGuest.tooManyRequests as any).mock.calls.length,
      0,
      'the pooled guests bucket is unaffected by the user bucket being over limit'
    )
  })
})

describe('limitAuthAttempts', () => {
  const makeAuthReq = (
    overrides: Partial<FastifyRequest> | Record<string, any> = {}
  ): FastifyRequest =>
    makeRequestStub({ ip: '203.0.113.9', method: 'POST', url: '/_api/auth/login', ...overrides })

  let consume: ReturnType<typeof mock.fn>
  let warn: ReturnType<typeof mock.fn>

  /** Every `warn('auth', message, fields)` call, as `[message, fields]`. */
  const warnCalls = (): Array<[string, any]> =>
    warn.mock.calls.map((call: any) => [call.arguments[1], call.arguments[2]])

  beforeEach(() => {
    consume = mock.fn(async () => ({ allowed: true, hits: 1, retryAfter: 0 }))
    warn = mock.fn()
    activeBanMemo.clear()
    resetCoalesce()
    wikiHandle = installTestWiki({
      config: {
        security: {
          authRateLimitEnabled: true,
          authRateLimitMax: 10,
          authRateLimitWindow: '5m',
          authRateLimitBan: '15m'
        }
      },
      models: {
        rateLimits: { consume }
      },
      logger: { warn, debug: mock.fn() }
    })
  })

  afterEach(() => {
    resetCoalesce()
    wikiHandle.restore()
  })

  test('lets an allowed attempt through, keyed by ip, and logs nothing', async () => {
    await limitAuthAttempts(makeAuthReq(), makeReplyStub().reply)

    assert.equal(consume.mock.calls.length, 1)
    assert.equal(consume.mock.calls[0].arguments[0], 'auth:203.0.113.9')
    assert.equal(warn.mock.calls.length, 0)
  })

  test('the ban line carries the count the ban was decided on', async () => {
    consume.mock.mockImplementation(async () => ({ allowed: false, hits: 11, retryAfter: 900 }))
    await limitAuthAttempts(makeAuthReq(), makeReplyStub().reply)

    assert.deepEqual(warnCalls(), [
      [
        'rate limit banned',
        {
          method: 'POST',
          url: '/_api/auth/login',
          ip: '203.0.113.9',
          hits: 11,
          retryAfter: 900
        }
      ]
    ])
    assert.equal(warn.mock.calls[0].arguments[0], 'auth', 'filed under the auth scope')
  })

  test('folds a burst of refusals into three lines and one summary', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    consume.mock.mockImplementation(async () => ({ allowed: false, hits: 11, retryAfter: 900 }))

    for (let i = 0; i < 20; i += 1) {
      await limitAuthAttempts(makeAuthReq(), makeReplyStub().reply)
    }
    assert.equal(warn.mock.calls.length, 3, 'twenty refusals, three lines')

    // -> `authRateLimitWindow: '5m'` above is the window the summary closes on.
    mock.timers.tick(300_000)
    const calls = warnCalls()
    assert.equal(calls.length, 4)
    assert.deepEqual(calls[3], ['rate limit banned 20 times in 300s', { ip: '203.0.113.9' }])
    mock.timers.reset()
  })

  test('counts each address separately', async () => {
    consume.mock.mockImplementation(async () => ({ allowed: false, hits: 11, retryAfter: 900 }))

    for (let i = 0; i < 5; i += 1) {
      await limitAuthAttempts(makeAuthReq({ ip: '203.0.113.9' }), makeReplyStub().reply)
    }
    for (let i = 0; i < 2; i += 1) {
      await limitAuthAttempts(makeAuthReq({ ip: '198.51.100.4' }), makeReplyStub().reply)
    }

    // -> Three from the first address (its threshold), both from the second: one client's burst
    //    must not silence another client's first refusal.
    assert.deepEqual(
      warnCalls().map(([, fields]) => fields.ip),
      ['203.0.113.9', '203.0.113.9', '203.0.113.9', '198.51.100.4', '198.51.100.4']
    )
  })

  test('still answers 429 with a Retry-After header for a folded refusal', async () => {
    consume.mock.mockImplementation(async () => ({ allowed: false, hits: 11, retryAfter: 42 }))

    let last = makeReplyStub()
    for (let i = 0; i < 5; i += 1) {
      last = makeReplyStub()
      await limitAuthAttempts(makeAuthReq(), last.reply)
    }

    // -> The fifth attempt is past the logging threshold; coalescing changes what is SAID about a
    //    refusal, never whether the client is refused.
    assert.deepEqual((last.reply as any).header.mock.calls[0].arguments, ['Retry-After', '42'])
    assert.equal(last.calls.tooManyRequests.length, 1)
  })

  test('does nothing at all when the limit is turned off', async () => {
    wikiHandle.restore()
    wikiHandle = installTestWiki({
      config: { security: { authRateLimitEnabled: false } },
      models: { rateLimits: { consume } },
      logger: { warn, debug: mock.fn() }
    })

    await limitAuthAttempts(makeAuthReq(), makeReplyStub().reply)
    assert.equal(consume.mock.calls.length, 0)
    assert.equal(warn.mock.calls.length, 0)
  })
})
