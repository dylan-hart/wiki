import fastify from 'fastify'
import fastifySensible from '@fastify/sensible'
import httpRoutes from '../mcp/http.ts'
import { installTestWiki } from './mocks.ts'

/**
 * The session-lifecycle half of `mcp/http.ts`'s coverage, shared by its eviction suites across two
 * test lanes. A harness rather than one test file importing another: `node --test` would run the
 * imported file's suites twice, once under each name.
 */

export const EVICTION_TOKEN = 'token-evict'

interface HarnessOptions {
  sessionIdleTtlMs: number
  sessionCap: number
  clock?: { now: () => number }
}

/**
 * Build one per test, never shared: these tests reason about exactly which sessions are live at a
 * given moment, which a shared store would make order- and timing-dependent. The caller owns
 * `close()`, which shuts the app down and restores the `CARDINAL` global.
 */
export async function createMcpSessionHarness({
  sessionIdleTtlMs,
  sessionCap,
  clock
}: HarnessOptions) {
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
  await app.register(httpRoutes, { sessionIdleTtlMs, sessionCap, clock })
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
   * Whether `sessionId` still resolves to a live session: 200 live, 404 evicted. A POST rather than
   * a GET because a GET opens the transport's standalone SSE push stream and holds the connection
   * open, which `app.inject()` would then wait forever on.
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
