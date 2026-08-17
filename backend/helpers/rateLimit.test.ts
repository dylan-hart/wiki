import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, mock, test } from 'node:test'
import { limitApiRequests } from './rateLimit.ts'
import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * Unit tests for `limitApiRequests` (task 635, feature 398): the general `/_api/*` rate-limit hook.
 *
 * `WIKI.models.rateLimits.consume` is stubbed rather than exercised against a real database — the
 * database-backed fixed-window logic itself belongs to `models/rateLimits.ts`, not this helper. What
 * this file covers is the hook's own job: which key it builds for a given request, which requests it
 * exempts, and how it turns a refused verdict into a 429 with `Retry-After` — matching
 * `limitAuthAttempts`/`limitRenders`'s existing shape.
 */

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

describe('limitApiRequests', () => {
  test('keys by apiKey id when the request carries a verified API key', async () => {
    const req = makeReq({ apiKey: { id: 'key-1', permissions: ['read:pages'] } })
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
      apiKey: { id: 'key-1', permissions: ['read:pages'] },
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
    const req = makeReq({ apiKey: { id: 'key-1', permissions: ['manage:system'] } })
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
