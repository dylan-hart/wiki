import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, mock, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import {
  isRootMountedPublicPath,
  limitApiRequests,
  limitPublicRequests
} from './helpers/rateLimit.ts'

/**
 * Task 2274: `index.ts`'s general `onRequest` rate-limit hook early-returned for any request that did
 * not start with `/_api/`, so every root-mounted public controller — `/sitemap.xml`, `/robots.txt`
 * (`controllers/seo.ts`), `/_icons`, `/_files`, `/_thumb`, `/_site` — carried no throttle of any kind.
 *
 * This file cannot `import './index.ts'` directly: that module runs real boot side effects
 * (`WIKI.configSvc.init()`, opening a real db connection, ...) at the top of the file the instant it
 * is imported, which is exactly the cost "fast and scoped" unit tests must not pay. Instead it
 * rebuilds `index.ts`'s own dispatch on a bare `fastify()` instance — `/_api/` → `limitApiRequests`,
 * a root-mounted public path → `limitPublicRequests`, anything else → neither — calling the *real*
 * exported functions `index.ts` wires into that hook (see the "General API Rate Limit" section
 * there), so this exercises the production dispatch logic itself rather than a re-description of it.
 * `helpers/rateLimit.test.ts` already covers each function's own key/exemption/429 behavior in
 * isolation; what this file adds is the routing between them.
 */
describe('root onRequest rate-limit dispatch (index.ts, task 2274)', () => {
  let app: FastifyInstance
  let consume: ReturnType<typeof mock.fn>

  beforeEach(async () => {
    consume = mock.fn(async () => ({ allowed: true, hits: 1, retryAfter: 0 }))
    ;(globalThis as any).WIKI = {
      config: { security: { apiRateLimitEnabled: true } },
      models: { rateLimits: { consume } },
      logger: { debug: mock.fn() }
    }

    app = fastify()
    await app.register(fastifySensible)

    // -> Stands in for the real session decoration `@fastify/session` performs before this hook runs
    //    in production: lets a test attach a session by header rather than needing the real plugin.
    app.addHook('onRequest', async (req) => {
      const perms = req.headers['x-session-permissions']
      if (typeof perms === 'string') {
        req.session = {
          authenticated: true,
          user: { id: 'test-user' },
          permissions: perms.split(',')
        } as any
      }
    })

    // -> The exact dispatch added to `index.ts`'s "General API Rate Limit" hook by task 2274.
    app.addHook('onRequest', async (req, reply) => {
      if (req.url.startsWith('/_api/')) {
        return limitApiRequests(req, reply)
      }
      if (isRootMountedPublicPath(req.url)) {
        return limitPublicRequests(req, reply)
      }
    })

    app.get('/_api/pages', async () => ({ ok: true }))
    app.get('/sitemap.xml', async () => 'sitemap')
    app.get('/robots.txt', async () => 'robots')
    app.get('/_icons/mdi.json', async () => ({ ok: true }))
    app.get('/some-wiki-page', async () => 'page')
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  test('fires the limiter for a root-mounted public path, budgeted under a public: key', async () => {
    const res = await app.inject({ method: 'GET', url: '/sitemap.xml' })
    assert.equal(res.statusCode, 200)
    assert.equal(consume.mock.calls.length, 1)
    const [key, policy] = consume.mock.calls[0].arguments as [string, any]
    assert.match(key, /^public:ip:/)
    // -> "a looser policy of its own": strictly more generous than the API's own 300/5min default,
    //    not the same policy reused for a wider path set.
    assert.ok(policy.max > 300, `expected a looser max than the API default, got ${policy.max}`)
  })

  test('leaves /_api/ on its own existing limiter and key namespace, unchanged', async () => {
    const res = await app.inject({ method: 'GET', url: '/_api/pages' })
    assert.equal(res.statusCode, 200)
    assert.equal(consume.mock.calls.length, 1)
    assert.match(consume.mock.calls[0].arguments[0] as string, /^api:ip:/)
  })

  test('a page path outside both namespaces trips neither limiter', async () => {
    const res = await app.inject({ method: 'GET', url: '/some-wiki-page' })
    assert.equal(res.statusCode, 200)
    assert.equal(consume.mock.calls.length, 0)
  })

  test('the same caller exhausting its /_api/ budget does not affect its public-route budget', async () => {
    const hits = new Map<string, number>()
    consume.mock.mockImplementation(async (key: string, policy: any) => {
      const n = (hits.get(key) ?? 0) + 1
      hits.set(key, n)
      return { allowed: n <= policy.max, hits: n, retryAfter: n <= policy.max ? 0 : 60 }
    })
    ;(globalThis as any).WIKI.config.security.apiRateLimitMax = 1

    await app.inject({ method: 'GET', url: '/_api/pages' })
    const secondApiCall = await app.inject({ method: 'GET', url: '/_api/pages' })
    assert.equal(secondApiCall.statusCode, 429)

    // -> Same caller (same IP), a root-mounted public route: accounted separately, so still allowed.
    const sitemapCall = await app.inject({ method: 'GET', url: '/sitemap.xml' })
    assert.equal(sitemapCall.statusCode, 200)
  })

  test('manage:system still exempts the public-path branch, same as /_api/', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sitemap.xml',
      headers: { 'x-session-permissions': 'manage:system' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(consume.mock.calls.length, 0)
  })

  test('apiRateLimitEnabled === false short-circuits the public-path branch too', async () => {
    ;(globalThis as any).WIKI.config.security.apiRateLimitEnabled = false
    const res = await app.inject({ method: 'GET', url: '/sitemap.xml' })
    assert.equal(res.statusCode, 200)
    assert.equal(consume.mock.calls.length, 0)
  })

  test('isRootMountedPublicPath matches exactly the routes task 2274 scopes in', () => {
    for (const path of [
      '/sitemap.xml',
      '/robots.txt',
      '/_icons/mdi.json',
      '/_files/foo.png',
      '/_thumb/1/thumb.jpg',
      '/_site/current/logo'
    ]) {
      assert.equal(isRootMountedPublicPath(path), true, path)
    }
    // -> Deliberately out of this task's scope, per `helpers/rateLimit.ts`'s own doc comment: already
    //    behind a session, a different check, or a decision left to whoever owns that route.
    for (const path of [
      '/_api/pages',
      '/_blocks/custom/1/x.js',
      '/_collab',
      '/_mcp/sse',
      '/some-wiki-page'
    ]) {
      assert.equal(isRootMountedPublicPath(path), false, path)
    }
    // -> A query string must not defeat the match.
    assert.equal(isRootMountedPublicPath('/sitemap.xml?locale=en'), true)
  })
})
