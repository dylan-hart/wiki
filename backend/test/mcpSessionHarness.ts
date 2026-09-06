import fastify from 'fastify'
import fastifySensible from '@fastify/sensible'
import httpRoutes from '../mcp/http.ts'
import { installTestWiki } from './mocks.ts'

/**
 * The session-lifecycle half of `mcp/http.ts`'s coverage (OpenProject #2207: the session map's idle
 * TTL and hard cap), shared by `mcp/http.test.ts`'s eviction describe and `mcp/http.flaky.test.ts`.
 *
 * It lives here rather than in either test file because those two files are deliberately in
 * different lanes — one quarantined, one not (`docs/decisions/flaky-test-quarantine.md`) — and a
 * test file must never import another test file: `node --test` would then run the imported file's
 * suites twice, once under each name. A plain `.ts` harness under `test/` is the convention for
 * exactly this (`test/collabHarness.ts` is the existing example).
 */

/** The one bearer token every stubbed `apiKeys.verify` below accepts. */
export const EVICTION_TOKEN = 'token-evict'

interface HarnessOptions {
  /** Milliseconds a session may sit untouched before the map evicts it. */
  sessionIdleTtlMs: number
  /** Hard ceiling on live sessions. */
  sessionCap: number
}

/**
 * A fresh app — and therefore a fresh, empty session store — plus the two request shapes every
 * session test needs. Both callers build one per test rather than sharing: these tests reason about
 * exactly which sessions are live at a given moment, which a store shared across tests would make
 * order- and timing-dependent.
 *
 * The caller owns the returned `close()`, which shuts the app down and restores the `WIKI` global.
 */
export async function createMcpSessionHarness({ sessionIdleTtlMs, sessionCap }: HarnessOptions) {
  const wikiHandle = installTestWiki({
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

  const app = fastify()
  await app.register(fastifySensible)
  await app.register(httpRoutes, { sessionIdleTtlMs, sessionCap })
  await app.ready()

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

  /** Opens a new MCP session and answers its `mcp-session-id`. */
  async function openSession(id = 1) {
    const res = await app.inject({
      method: 'POST',
      url: '/',
      headers: {
        authorization: `Bearer ${EVICTION_TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      payload: initializeRequest(id)
    })
    return res.headers['mcp-session-id'] as string
  }

  /**
   * Whether `sessionId` still resolves to a live session — a plain POST tool call rather than GET,
   * since a GET here opens the transport's standalone SSE push stream (per the SDK's own
   * Accept-header requirement) and holds the connection open, which `app.inject()` would then wait
   * forever on. A `tools/list` POST gets one JSON-RPC response and completes, the same pattern
   * `mcp/http.test.ts`'s main suite uses for "reaches the same MCP session" — 200 means still live,
   * 404 means evicted.
   */
  async function pollSession(sessionId: string) {
    return app.inject({
      method: 'POST',
      url: '/',
      headers: {
        authorization: `Bearer ${EVICTION_TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId
      },
      payload: { jsonrpc: '2.0', id: 99, method: 'tools/list' }
    })
  }

  async function close() {
    await app.close()
    wikiHandle.restore()
  }

  return { app, openSession, pollSession, close }
}
