/**
 * MCP server, Streamable HTTP transport (spec revision 2025-03-26 and later): request/response
 * POSTs, plus an SSE stream on the same endpoint for server pushes. Mounted at `/_mcp` inside the
 * main Fastify process.
 *
 * Auth is per request, not per process. This plugin sits outside `/_api/`, so that prefix's
 * bearer-token hook never runs for it and the `onRequest` hook below stands in. The token is
 * re-verified on every request whichever session it names, so a session never outlives its key.
 *
 * The SDK transport is stateful — one instance per `Mcp-Session-Id` — and speaks the Fetch API's
 * `Request`/`Response`, hence `webBridge.ts`. `sessions` is capped and idle-expiring because a
 * client that crashes never sends `DELETE`, and the rate limiter alone does not bound how many
 * sessions one key can open.
 */

import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { LRUCache } from 'lru-cache'
import {
  WebStandardStreamableHTTPServerTransport,
  isInitializeRequest
} from '@modelcontextprotocol/server'
import { limitApiKey } from '../helpers/rateLimit.ts'
import { actorFromRequest } from '../models/auditLog.ts'
import { contextFromIdentity, type McpAuthContext } from './auth.ts'
import { createMcpServer } from './server.ts'
import { registerAllTools } from './tools/index.ts'
import { sendWebResponse, toWebRequest } from './webBridge.ts'

interface McpSession {
  transport: WebStandardStreamableHTTPServerTransport
  /** The key that opened this session — a later request naming this session must be the same key. */
  keyId: string
  /**
   * Mutable: refreshed to each request's freshly verified context before dispatch, so a long-lived
   * session never keeps authorizing against the identity that opened it.
   */
  ctx: McpAuthContext
}

const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60 * 1000

const DEFAULT_SESSION_CAP = 1000

/** Test-only overrides of the two defaults above. */
interface HttpRoutesOptions {
  sessionIdleTtlMs?: number
  sessionCap?: number
}

function sessionIdOf(req: {
  headers: Record<string, string | string[] | undefined>
}): string | undefined {
  const raw = req.headers['mcp-session-id']
  return Array.isArray(raw) ? raw[0] : raw
}

async function routes(app: FastifyInstance, opts: HttpRoutesOptions = {}) {
  /** Process-local: an HTTP/SSE session belongs to whichever instance's request created it. */
  const sessions = new LRUCache<string, McpSession>({
    max: opts.sessionCap ?? DEFAULT_SESSION_CAP,
    ttl: opts.sessionIdleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS,
    // -> Idle-based, not absolute-lifetime: every handler below `.get()`s a session before acting on
    //    it, which restarts the ttl.
    updateAgeOnGet: true,
    // -> Only an automatic eviction (cap or ttl) needs the transport closed here — an explicit
    //    `sessions.delete()` comes from the transport's own `onclose`, so it is already closed.
    dispose: (session, _sessionId, reason) => {
      if (reason === 'delete') {
        return
      }
      Promise.resolve(session.transport.close()).catch((err: any) => {
        CARDINAL.logger.debug('mcp', "closing an evicted session's transport failed", {
          error: err
        })
      })
    }
  })

  app.decorateRequest('mcpCtx', null)

  app.addHook('onRequest', async (req, reply) => {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      return reply.unauthorized(
        'An MCP request needs a bearer token — mint one via the API Keys admin screen, or POST /_api/system/api-keys.'
      )
    }
    const token = header.slice('Bearer '.length).trim()
    if (!token) {
      return reply.unauthorized('An MCP request needs a bearer token.')
    }

    let identity
    try {
      identity = await CARDINAL.models.apiKeys.verify(token)
    } catch (err: any) {
      // -> `warn`, not `debug`: a refused credential is security-relevant, and at `debug` an
      //    operator could not see it in a production deployment.
      CARDINAL.logger.warn('mcp', 'bearer token refused', { error: err })
      return reply.unauthorized(err.message)
    }
    // -> The limiter `/_api/` applies to a bearer-token request. It reads `req.apiKey`, as does
    //    `actorFromRequest` below.
    req.apiKey = identity
    await limitApiKey(req, reply)
    if (reply.sent) {
      return
    }

    req.mcpCtx = contextFromIdentity(identity)
  })

  app.post('/', async (req, reply) => {
    const ctx = req.mcpCtx!
    const sessionId = sessionIdOf(req)
    let session = sessionId ? sessions.get(sessionId) : undefined

    if (session && session.keyId !== ctx.keyId) {
      return reply.forbidden('This MCP session belongs to a different API key.')
    }

    if (!session) {
      if (sessionId) {
        return reply.notFound(
          'No MCP session with this id. Start a new one by sending an `initialize` request with no `Mcp-Session-Id` header.'
        )
      }
      if (!isInitializeRequest(req.body)) {
        return reply.badRequest('Expected an `initialize` request to start a new MCP session.')
      }

      const server = createMcpServer(CARDINAL.version)
      const newSession: McpSession = { transport: undefined as any, keyId: ctx.keyId, ctx }
      // -> Through `newSession.ctx`, not the `ctx` captured above — see `McpSession.ctx`.
      registerAllTools(server, () => newSession.ctx)
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: async (sid) => {
          sessions.set(sid, newSession)
          await CARDINAL.models.auditLog.record({
            event: 'mcp.sessionOpened',
            actor: actorFromRequest(req),
            targetType: 'apiKey',
            targetId: ctx.keyId,
            targetLabel: `API Key ${ctx.keyId}`,
            detail: { transport: 'http', sessionId: sid },
            siteId: ctx.siteId
          })
        }
      })
      newSession.transport = transport
      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId)
        }
      }
      await server.connect(transport)
      session = newSession
    }

    // -> Refresh to this request's own verification before dispatching — see `McpSession.ctx`.
    session.ctx = ctx

    const webRes = await session.transport.handleRequest(toWebRequest(req), {
      parsedBody: req.body
    })
    reply.hijack()
    await sendWebResponse(reply, webRes)
  })

  function loadOwnSession(
    req: FastifyRequest
  ): { session: McpSession; error: null } | { session: null; error: 'notFound' | 'forbidden' } {
    const ctx = req.mcpCtx!
    const sessionId = sessionIdOf(req)
    const session = sessionId ? sessions.get(sessionId) : undefined
    if (!session) {
      return { session: null, error: 'notFound' }
    }
    if (session.keyId !== ctx.keyId) {
      return { session: null, error: 'forbidden' }
    }
    // -> Same refresh as the POST handler.
    session.ctx = ctx
    return { session, error: null }
  }

  app.get('/', async (req, reply) => {
    const { session, error } = loadOwnSession(req)
    if (error === 'forbidden') {
      return reply.forbidden('This MCP session belongs to a different API key.')
    }
    if (!session) {
      return reply.notFound('No MCP session with this id.')
    }
    const webRes = await session.transport.handleRequest(toWebRequest(req))
    reply.hijack()
    await sendWebResponse(reply, webRes)
  })

  app.delete('/', async (req, reply) => {
    const { session, error } = loadOwnSession(req)
    if (error === 'forbidden') {
      return reply.forbidden('This MCP session belongs to a different API key.')
    }
    if (!session) {
      return reply.notFound('No MCP session with this id.')
    }
    const webRes = await session.transport.handleRequest(toWebRequest(req))
    reply.hijack()
    await sendWebResponse(reply, webRes)
  })
}

export default routes
