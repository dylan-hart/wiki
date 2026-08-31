import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import httpRoutes from './http.ts'

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
    ;(globalThis as any).WIKI = {
      version: '3.0.0-test',
      sites: {
        [SITE_X]: { id: SITE_X, hostname: 'x.example.com', isEnabled: true, config: {} },
        [SITE_Y]: { id: SITE_Y, hostname: 'y.example.com', isEnabled: true, config: {} }
      },
      logger: { debug: () => {} },
      models: {
        apiKeys: {
          verify: async (token: string) => {
            verifyCalls.push(token)
            return identityFor(token)
          }
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
    }

    app = fastify()
    await app.register(fastifySensible)
    await app.register(httpRoutes)
    await app.ready()
  })

  after(async () => {
    await app.close()
    delete (globalThis as any).WIKI
  })

  beforeEach(() => {
    verifyCalls = []
    rateLimitAllowed = true
    tokenASiteId = null
    auditCalls = []
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
