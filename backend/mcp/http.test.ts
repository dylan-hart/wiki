import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { activeBanMemo } from '../helpers/rateLimit.ts'
import httpRoutes from './http.ts'
import { installTestWiki } from '../test/mocks.ts'

let wikiHandle: { restore(): void }

/**
 * Exercises `mcp/http.ts` as a real Fastify plugin (`app.inject()`, same pattern
 * `helpers/rateLimit.test.ts` and `controllers/site.test.ts` use) rather than unit-testing its
 * internals directly — the thing actually worth proving here is the wiring: per-request bearer auth,
 * the rate limiter, and the session lifecycle the MCP SDK's `StreamableHTTPServerTransport` expects,
 * all glued into Fastify's request/reply cycle including `reply.hijack()`. The transport's own
 * protocol-framing correctness is the SDK's problem, not this suite's; `WIKI.models.apiKeys.verify`
 * and `WIKI.models.rateLimits.consume` are stubbed so no database is touched.
 */
describe('mcp/http', () => {
  let app: FastifyInstance
  let verifyCalls: string[]
  let rateLimitAllowed: boolean
  let auditCalls: any[]

  const TOKEN_A = 'token-a'
  const TOKEN_B = 'token-b'
  const SITE_X = 'site-x'
  const SITE_Y = 'site-y'

  /** Mutated mid-test to prove a session re-reads it on every request. See the 'reflects a token's
   *  freshly re-verified scope' test below. */
  let tokenASiteId: string | null

  function identityFor(token: string) {
    if (token === TOKEN_A) {
      return {
        id: 'key-a',
        permissions: [],
        siteId: tokenASiteId,
        groupIds: ['group-a'],
        userId: 'user-a'
      }
    }
    if (token === TOKEN_B) {
      return {
        id: 'key-b',
        permissions: [],
        siteId: null,
        groupIds: ['group-b'],
        userId: 'user-b'
      }
    }
    throw new Error('API key does not exist.')
  }

  before(async () => {
    wikiHandle = installTestWiki({
      version: '3.0.0-test',
      sites: {
        [SITE_X]: { id: SITE_X, hostname: 'x.example.com', isEnabled: true, config: {} },
        [SITE_Y]: { id: SITE_Y, hostname: 'y.example.com', isEnabled: true, config: {} }
      },
      models: {
        apiKeys: {
          verify: async (token: string) => {
            verifyCalls.push(token)
            return identityFor(token)
          }
        },
        // -> `list_sites` (OpenProject #2193) checks `read:pages` per site for a caller with no
        //    `access:admin`/`manage:sites`; this suite's tokens hold neither, so it stubs a rule
        //    granting the read everywhere rather than testing that gating itself (covered by
        //    `mcp/tools/listSites.test.ts`) — the point of this file is the HTTP/session wiring.
        groups: {
          checkAccess: () => true
        },
        rateLimits: {
          consume: async () => ({ allowed: rateLimitAllowed, hits: 1, retryAfter: 42 })
        },
        auditLog: {
          record: async (entry: any) => {
            auditCalls.push(entry)
          }
        }
      }
    })

    app = fastify()
    await app.register(fastifySensible)
    await app.register(httpRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    wikiHandle.restore()
  })

  beforeEach(() => {
    verifyCalls = []
    rateLimitAllowed = true
    tokenASiteId = null
    auditCalls = []
    // -> `limitApiKey`'s ban memo (`helpers/rateLimit.ts#activeBanMemo`) is a module-level singleton
    //    shared across every test in this file; clearing it here keeps the "over its rate limit" test
    //    below from banning TOKEN_A for real (42s TTL) and bleeding a 429 into every test after it —
    //    same reasoning as `rateLimit.test.ts`'s own `beforeEach`.
    activeBanMemo.clear()
  })

  function initializeRequest() {
    return {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0' }
      }
    }
  }

  async function openSession(token = TOKEN_A) {
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      payload: initializeRequest()
    })
    return res
  }

  function sseResult(body: string): any {
    const dataLine = body.split('\n').find((l) => l.startsWith('data:'))
    return JSON.parse(dataLine!.slice('data:'.length).trim())
  }

  test('POST with no Authorization header is refused with 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/', payload: initializeRequest() })
    assert.equal(res.statusCode, 401)
    assert.equal(verifyCalls.length, 0)
  })

  test('POST with a malformed Authorization header is refused with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: { authorization: 'Token abc' },
      payload: initializeRequest()
    })
    assert.equal(res.statusCode, 401)
  })

  test('POST with an unverifiable token is refused with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
      payload: initializeRequest()
    })
    assert.equal(res.statusCode, 401)
    assert.deepEqual(verifyCalls, ['nope'])
  })

  test('a valid token over its rate limit is refused with 429', async () => {
    rateLimitAllowed = false
    const res = await openSession()
    assert.equal(res.statusCode, 429)
  })

  test('POST naming an unknown session id is refused with 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
        'mcp-session-id': 'no-such-session'
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    })
    assert.equal(res.statusCode, 404)
  })

  test('POST with no session id and a non-initialize body is refused with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    })
    assert.equal(res.statusCode, 400)
  })

  test('GET/DELETE naming an unknown session id are refused with 404', async () => {
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await app.inject({
        method,
        url: '/',
        headers: { authorization: `Bearer ${TOKEN_A}`, 'mcp-session-id': 'no-such-session' }
      })
      assert.equal(res.statusCode, 404)
    }
  })

  test('initialize opens a session: 200, an Mcp-Session-Id header, and the server info', async () => {
    const res = await openSession()
    assert.equal(res.statusCode, 200)
    assert.ok(res.headers['mcp-session-id'])
    const message = sseResult(res.body)
    assert.equal(message.result.serverInfo.name, 'wikijs-mcp')
    assert.equal(message.result.serverInfo.version, '3.0.0-test')
  })

  test('initialize records an mcp.sessionOpened audit log entry, attributed like any other apiKey-authenticated request', async () => {
    const res = await openSession(TOKEN_A)
    const sessionId = res.headers['mcp-session-id'] as string

    assert.equal(auditCalls.length, 1)
    assert.equal(auditCalls[0].event, 'mcp.sessionOpened')
    assert.deepEqual(auditCalls[0].actor, { id: null, name: 'API Key key-a', ip: '127.0.0.1' })
    assert.equal(auditCalls[0].targetType, 'apiKey')
    assert.equal(auditCalls[0].targetId, 'key-a')
    assert.deepEqual(auditCalls[0].detail, { transport: 'http', sessionId })
  })

  test('a follow-up POST on an existing session does not open a second one, so it does not log a second mcp.sessionOpened entry', async () => {
    const opened = await openSession()
    const sessionId = opened.headers['mcp-session-id'] as string

    await app.inject({
      method: 'POST',
      url: '/',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId
      },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' }
    })

    assert.equal(auditCalls.length, 1)
  })

  test('a follow-up POST on an existing session re-authorizes against that request own fresh verification, not the identity that opened it', async () => {
    // Token A opens the session unscoped (siteId null) and sees both sites.
    const opened = await openSession()
    const sessionId = opened.headers['mcp-session-id'] as string

    async function listSites() {
      const res = await app.inject({
        method: 'POST',
        url: '/',
        headers: {
          authorization: `Bearer ${TOKEN_A}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId
        },
        payload: {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'list_sites', arguments: {} }
        }
      })
      assert.equal(res.statusCode, 200)
      const message = sseResult(res.body)
      return JSON.parse(message.result.content[0].text) as Array<{ id: string }>
    }

    assert.deepEqual((await listSites()).map((s) => s.id).sort(), [SITE_X, SITE_Y])

    // An admin narrows this same key's scope to one site — no new session, same bearer token.
    tokenASiteId = SITE_X
    const scoped = await listSites()
    assert.deepEqual(
      scoped.map((s) => s.id),
      [SITE_X]
    )
  })

  test('a follow-up POST on the same session id reaches the same MCP session', async () => {
    const opened = await openSession()
    const sessionId = opened.headers['mcp-session-id'] as string

    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId
      },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' }
    })
    assert.equal(res.statusCode, 200)
    const message = sseResult(res.body)
    const toolNames = message.result.tools.map((t: any) => t.name).sort()
    assert.deepEqual(toolNames, [
      'create_page',
      'delete_asset',
      'get_page',
      'list_navigation',
      'list_sites',
      'render_diagram',
      'search_pages',
      'update_page'
    ])
  })

  test('a different bearer token may not reuse someone else’s session id (POST/GET/DELETE)', async () => {
    const opened = await openSession(TOKEN_A)
    const sessionId = opened.headers['mcp-session-id'] as string

    const postRes = await app.inject({
      method: 'POST',
      url: '/',
      headers: {
        authorization: `Bearer ${TOKEN_B}`,
        'content-type': 'application/json',
        'mcp-session-id': sessionId
      },
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' }
    })
    assert.equal(postRes.statusCode, 403)

    for (const method of ['GET', 'DELETE'] as const) {
      const res = await app.inject({
        method,
        url: '/',
        headers: { authorization: `Bearer ${TOKEN_B}`, 'mcp-session-id': sessionId }
      })
      assert.equal(res.statusCode, 403)
    }
  })

  test('DELETE ends the session: a later POST on the same id is refused with 404', async () => {
    const opened = await openSession()
    const sessionId = opened.headers['mcp-session-id'] as string

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: '/',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'mcp-session-id': sessionId }
    })
    assert.equal(deleteRes.statusCode, 200)

    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: {
        authorization: `Bearer ${TOKEN_A}`,
        'content-type': 'application/json',
        'mcp-session-id': sessionId
      },
      payload: { jsonrpc: '2.0', id: 3, method: 'tools/list' }
    })
    assert.equal(res.statusCode, 404)
  })
})

/**
 * OpenProject #2207: the session map's idle TTL and hard cap. A separate app/describe block, built
 * with test-sized `sessionIdleTtlMs`/`sessionCap` overrides (`mcp/http.ts`'s `HttpRoutesOptions`) —
 * the default 30-minute idle TTL and 1000-session cap are not something a unit test should wait out or
 * open a thousand real sessions to exercise.
 */
describe('mcp/http session eviction (OpenProject #2207)', () => {
  let app: FastifyInstance
  const TOKEN = 'token-evict'

  // -> A fresh app (and therefore a fresh, empty session store) per test: these tests reason about
  //    exactly which sessions are live at a given moment, which a store shared across tests would
  //    make flaky depending on run order and timing.
  beforeEach(async () => {
    wikiHandle = installTestWiki({
      version: '3.0.0-test',
      models: {
        apiKeys: {
          verify: async () => ({
            id: 'key-evict',
            permissions: [],
            siteId: null,
            groupIds: [],
            userId: 'user-evict'
          })
        },
        rateLimits: {
          consume: async () => ({ allowed: true, hits: 1, retryAfter: 42 })
        },
        auditLog: {
          record: async () => {}
        }
      }
    })

    app = fastify()
    await app.register(fastifySensible)
    // -> A tiny idle ttl and a cap of 2, so both eviction paths fire within a fast test run.
    await app.register(httpRoutes, { sessionIdleTtlMs: 30, sessionCap: 2 })
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    wikiHandle.restore()
  })

  function initializeRequest(id: number) {
    return {
      jsonrpc: '2.0' as const,
      id,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0' }
      }
    }
  }

  async function openSession(id = 1) {
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      payload: initializeRequest(id)
    })
    return res.headers['mcp-session-id'] as string
  }

  /**
   * Whether `sessionId` still resolves to a live session — a plain POST tool call rather than GET,
   * since a GET here opens the transport's standalone SSE push stream (per the SDK's own Accept-header
   * requirement) and holds the connection open, which `app.inject()` would then wait forever on. A
   * `tools/list` POST gets one JSON-RPC response and completes, the same pattern the suite above uses
   * for "reaches the same MCP session" — 200 means still live, 404 means evicted.
   */
  async function pollSession(sessionId: string) {
    return app.inject({
      method: 'POST',
      url: '/',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId
      },
      payload: { jsonrpc: '2.0', id: 99, method: 'tools/list' }
    })
  }

  test('an idle session is evicted (no longer reachable) and its transport is closed', async () => {
    const closeSpy = mock.method(StreamableHTTPServerTransport.prototype, 'close', async () => {})
    try {
      const sessionId = await openSession()
      // -> Confirm it is reachable right after opening, before the ttl has had a chance to lapse.
      assert.equal((await pollSession(sessionId)).statusCode, 200)

      // -> Longer than the 30ms sessionIdleTtlMs above, with no request touching the session in
      //    between so nothing resets its idle clock.
      await new Promise((resolve) => setTimeout(resolve, 150))

      // -> `LRUCache` evicts lazily, on the next touch of the stale entry — this `.get()` (via
      //    `pollSession`) is what actually triggers the sweep/dispose, and should itself find nothing.
      assert.equal(
        (await pollSession(sessionId)).statusCode,
        404,
        'an idle-expired session id should no longer resolve to a live session'
      )
      assert.ok(
        closeSpy.mock.callCount() >= 1,
        'expected the evicted transport to have been closed'
      )
    } finally {
      closeSpy.mock.restore()
    }
  })

  test('the session map does not grow past its cap: opening a third session evicts the oldest-idle one', async () => {
    const sessionA = await openSession(1)
    // -> Keep A's idle clock fresh so eviction has to pick something other than "oldest inserted".
    await pollSession(sessionA)
    const sessionB = await openSession(2)
    const sessionC = await openSession(3)

    // -> Cap is 2: opening a third session must have evicted exactly one of the first two.
    const [resA, resB, resC] = await Promise.all([
      pollSession(sessionA),
      pollSession(sessionB),
      pollSession(sessionC)
    ])
    const stillLive = [resA, resB, resC].filter((r) => r.statusCode === 200)
    assert.equal(
      stillLive.length,
      2,
      'exactly two of the three sessions should remain live under the cap'
    )
  })

  test('an active session is not evicted while it is still being used', async () => {
    const sessionId = await openSession()
    // -> Repeatedly touch the session across a span longer than the idle ttl, with each touch well
    //    inside the ttl window of the previous one — `updateAgeOnGet` should keep resetting its clock.
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 15))
      const res = await pollSession(sessionId)
      assert.equal(res.statusCode, 200, `expected the session to still be live on touch #${i}`)
    }
  })
})
