import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import {
  isPublicRateLimitedPath,
  limitApiRequests,
  limitPublicRequests
} from './helpers/rateLimit.ts'

/**
 * OpenProject #2274: `index.ts` itself runs its boot sequence at import time (`await preBoot()` etc.
 * at the bottom of the file), so it cannot be imported into a test the way an ordinary module can —
 * the same reason `helpers/rateLimit.test.ts`'s `limitApiKey` suite builds its own small fastify
 * instance rather than importing the real one. This file does the same for the two `onRequest` hooks
 * `index.ts` registers back to back: the pre-existing `/_api/`-scoped one and the new root-mounted
 * public-surface one, wired here exactly as `index.ts` wires them (same `req.url` prefix check, same
 * `isPublicRateLimitedPath` gate, same handlers), so the only thing under test is the wiring itself --
 * that a root-mounted public path now reaches a limiter at all, and that it reaches the NEW one, not
 * the `/_api/` one, with its own separately-accounted bucket.
 */
describe('rate limiter hook wiring (index.ts)', () => {
  let app: FastifyInstance
  let consume: ReturnType<typeof mock.fn>

  before(async () => {
    app = fastify()
    await app.register(fastifySensible)

    // -> Mirrors index.ts's two `onRequest` hooks, in the same order, using the same exported
    //    helpers -- see the two "General API Rate Limit" / "Public Surface Rate Limit" blocks there.
    app.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/_api/')) {
        return
      }
      return limitApiRequests(req, reply)
    })
    app.addHook('onRequest', async (req, reply) => {
      const path = req.url.split('?')[0] ?? req.url
      if (!isPublicRateLimitedPath(path)) {
        return
      }
      return limitPublicRequests(req, reply)
    })

    app.get('/_api/pages', async () => ({ ok: true }))
    app.get('/sitemap.xml', async () => '<urlset></urlset>')
    app.get('/login', async () => ({ ok: true }))

    await app.ready()
  })

  after(async () => {
    await app.close()
  })

  beforeEach(() => {
    consume = mock.fn(async () => ({ allowed: true, hits: 1, retryAfter: 0 }))
    ;(globalThis as any).WIKI = {
      config: { security: { apiRateLimitEnabled: true, apiRateLimitMax: 300 } },
      models: { rateLimits: { consume } },
      logger: { debug: mock.fn() }
    }
  })

  afterEach(() => {
    delete (globalThis as any).WIKI
  })

  test('a request to a root-mounted public path reaches the public limiter', async () => {
    const res = await app.inject({ method: 'GET', url: '/sitemap.xml' })
    assert.equal(res.statusCode, 200)
    assert.equal(consume.mock.calls.length, 1)
    assert.equal(consume.mock.calls[0].arguments[0], 'public:ip:127.0.0.1')
  })

  test('a request to an untouched route (neither /_api/ nor a public path) reaches no limiter', async () => {
    const res = await app.inject({ method: 'GET', url: '/login' })
    assert.equal(res.statusCode, 200)
    assert.equal(consume.mock.calls.length, 0)
  })

  test('a root-mounted public path never reaches the /_api/ limiter', async () => {
    await app.inject({ method: 'GET', url: '/sitemap.xml' })
    assert.ok(
      consume.mock.calls.every((call) => (call.arguments[0] as string).startsWith('public:'))
    )
  })

  test("the public path's budget is accounted separately from /_api/'s", async () => {
    const hits = new Map<string, number>()
    consume.mock.mockImplementation(async (key: string, policy: any) => {
      const n = (hits.get(key) ?? 0) + 1
      hits.set(key, n)
      return { allowed: n <= policy.max, hits: n, retryAfter: n <= policy.max ? 0 : 60 }
    })
    ;(globalThis as any).WIKI.config.security.apiRateLimitMax = 1

    // First /_api/ request consumes the /_api/ bucket's one allowed slot.
    const firstApi = await app.inject({ method: 'GET', url: '/_api/pages' })
    assert.equal(firstApi.statusCode, 200)
    // A second /_api/ request is refused -- its bucket is now exhausted.
    const secondApi = await app.inject({ method: 'GET', url: '/_api/pages' })
    assert.equal(secondApi.statusCode, 429)

    // The public path, from the same caller, is on its own bucket and unaffected.
    const publicReq = await app.inject({ method: 'GET', url: '/sitemap.xml' })
    assert.equal(publicReq.statusCode, 200)
  })
})
