import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { activeBanMemo } from '../helpers/rateLimit.ts'
import httpRoutes from './http.ts'
import { installTestWiki } from '../test/mocks.ts'
import { createMcpSessionHarness } from '../test/mcpSessionHarness.ts'

let wikiHandle: { restore(): void }

/**
 * Driven as a real Fastify plugin (`app.inject()`): what is worth proving is the wiring — bearer
 * auth, the rate limiter and the SDK transport's session lifecycle glued into Fastify's
 * request/reply cycle, `reply.hijack()` and `webBridge.ts` included — not the SDK's own protocol
 * framing. `app` sets no `bodyLimit`, so Fastify's 1 MiB default applies; the 413 test relies on it.
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

  /** Mutated mid-test to prove a session re-reads it on every request. */
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
        // -> `list_sites` checks `read:pages` per site for a caller without `access:admin`/
        //    `manage:sites`. Granted everywhere here: that gating is `mcp/tools/listSites.test.ts`'s.
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
    // -> `limitApiKey`'s ban memo is a module-level singleton: uncleared, the rate-limit test below
    //    bans TOKEN_A for real and bleeds a 429 into every test after it.
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

  test('a request body over the size limit is refused with 413', async () => {
    // -> Fastify's instance-level `bodyLimit` refuses this, not `mcp/http.ts` itself. The token is
    //    valid so the `onRequest` auth hook, which runs before the body is parsed, passes and the
    //    refusal under test is the size one.
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { padding: 'x'.repeat(2 * 1024 * 1024) }
      })
    })
    assert.equal(res.statusCode, 413)
    assert.deepEqual(verifyCalls, [TOKEN_A])
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
    assert.equal(message.result.serverInfo.name, 'cardinaljs-mcp')
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
      'list_assets',
      'list_navigation',
      'list_page_watchers',
      'list_sites',
      'list_watched_pages',
      'rename_asset',
      'render_diagram',
      'search_pages',
      'set_page_watch_preference',
      'sideload_icons',
      'sideload_locales',
      'unwatch_page',
      'update_page',
      'upload_asset',
      'watch_page'
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
 * The third claim — an ACTIVE session is never evicted — lives in `mcp/http.flaky.test.ts`: only
 * that direction can be falsified by a slow run. The two below assert that eviction HAPPENS, which
 * a slow run only makes more true.
 */
describe('mcp/http session eviction (OpenProject #2207)', () => {
  let harness: Awaited<ReturnType<typeof createMcpSessionHarness>>

  // -> A fresh harness, so an empty session store, per test: these reason about exactly which
  //    sessions are live. A tiny idle ttl and a cap of 2 so both eviction paths fire quickly.
  beforeEach(async () => {
    harness = await createMcpSessionHarness({ sessionIdleTtlMs: 30, sessionCap: 2 })
  })

  afterEach(async () => {
    await harness.close()
  })

  test('an idle session is evicted (no longer reachable) and its transport is closed', async () => {
    const closeSpy = mock.method(
      WebStandardStreamableHTTPServerTransport.prototype,
      'close',
      async () => {}
    )
    try {
      const sessionId = await harness.openSession()
      assert.equal((await harness.pollSession(sessionId)).statusCode, 200)

      // -> Well past the 30ms idle ttl, with nothing touching the session in between.
      await new Promise((resolve) => setTimeout(resolve, 150))

      // -> `LRUCache` evicts lazily: this `.get()` (via `pollSession`) is what triggers the dispose.
      assert.equal(
        (await harness.pollSession(sessionId)).statusCode,
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
    const sessionA = await harness.openSession(1)
    // -> Keep A's idle clock fresh so eviction has to pick something other than "oldest inserted".
    await harness.pollSession(sessionA)
    const sessionB = await harness.openSession(2)
    const sessionC = await harness.openSession(3)

    const [resA, resB, resC] = await Promise.all([
      harness.pollSession(sessionA),
      harness.pollSession(sessionB),
      harness.pollSession(sessionC)
    ])
    const stillLive = [resA, resB, resC].filter((r) => r.statusCode === 200)
    assert.equal(
      stillLive.length,
      2,
      'exactly two of the three sessions should remain live under the cap'
    )
  })
})

describe('mcp/http session eviction, active-session liveness (OpenProject #2207)', () => {
  let harness: Awaited<ReturnType<typeof createMcpSessionHarness>>
  let nowMs: number

  beforeEach(async () => {
    nowMs = 1000
    harness = await createMcpSessionHarness({
      sessionIdleTtlMs: 30,
      sessionCap: 2,
      clock: { now: () => nowMs }
    })
  })

  afterEach(async () => {
    await harness.close()
  })

  test('an active session is not evicted while it is still being used', async () => {
    const sessionId = await harness.openSession()
    for (let i = 0; i < 5; i++) {
      nowMs += 20
      const res = await harness.pollSession(sessionId)
      assert.equal(res.statusCode, 200, `expected the session to still be live on touch #${i}`)
    }
  })

  test('the same session is evicted once it goes idle past the ttl', async () => {
    const sessionId = await harness.openSession()
    nowMs += 20
    assert.equal((await harness.pollSession(sessionId)).statusCode, 200)
    nowMs += 31
    assert.equal((await harness.pollSession(sessionId)).statusCode, 404)
  })
})
