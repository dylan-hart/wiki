/**
 * MCP server, Streamable HTTP transport (spec revision 2025-03-26 and later — request/response POSTs,
 * with an SSE stream on the same endpoint for anything the server needs to push).
 *
 * Mounted at `/_mcp` in `index.ts`, inside the very same Fastify process `node backend` already runs —
 * the reference/production way to reach this wiki's MCP tools. `mcp/stdio.ts` remains available
 * alongside it as the lightweight local/desktop-client transport (same image, same codebase, a
 * different entrypoint script); see that file's doc comment. Nobody stands up a second image/container
 * for either.
 *
 * Auth is per REQUEST, not per process: every request carries its own `Authorization: Bearer <token>`,
 * verified fresh by the `onRequest` hook below exactly like `/_api/` verifies one (`index.ts`) — this
 * plugin is registered outside `/_api/`, so that hook never runs for it, and this one stands in. A
 * personal access token is what makes multiple humans share one endpoint safely: each request is
 * authorized as its own caller's real page-rule grants (`mcp/auth.ts`'s `McpAuthContext`), not a
 * process-wide identity the way stdio's single configured key is.
 *
 * Session lifecycle: the SDK's `StreamableHTTPServerTransport` is stateful — one instance per MCP
 * session, addressed by the `Mcp-Session-Id` header a client is handed on `initialize` and echoes on
 * every request after. `sessions` below is the process-local map from that id to its transport (and
 * the key that opened it); a session that outlives its own key's revocation still gets refused, since
 * the bearer token is re-verified on every request regardless of which session it names.
 */

import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { limitApiKey } from '../helpers/rateLimit.ts'
import { contextFromIdentity } from './auth.ts'
import { createMcpServer } from './server.ts'
import { registerAllTools } from './tools/index.ts'

interface McpSession {
  transport: StreamableHTTPServerTransport
  /** The key that opened this session — a later request naming this session must be the same key. */
  keyId: string
}

/** Process-local: an HTTP/SSE session belongs to whichever instance's request created it. */
const sessions = new Map<string, McpSession>()

function sessionIdOf(req: {
  headers: Record<string, string | string[] | undefined>
}): string | undefined {
  const raw = req.headers['mcp-session-id']
  return Array.isArray(raw) ? raw[0] : raw
}

async function routes(app: FastifyInstance) {
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
      identity = await WIKI.models.apiKeys.verify(token)
    } catch (err: any) {
      WIKI.logger.debug(`Rejected an MCP bearer token: ${err.message}`)
      return reply.unauthorized(err.message)
    }
    // -> Same limiter `/_api/` applies to every bearer-token request; reused as-is rather than
    //    reinvented, since it already asks exactly the question this endpoint needs answered.
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

      const server = createMcpServer(WIKI.version)
      registerAllTools(server, ctx)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, { transport, keyId: ctx.keyId })
        }
      })
      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId)
        }
      }
      await server.connect(transport)
      session = { transport, keyId: ctx.keyId }
    }

    reply.hijack()
    await session.transport.handleRequest(req.raw, reply.raw, req.body)
  })

  /** The session a GET/DELETE names, distinguishing "no such session" from "not yours" — same as POST. */
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
    reply.hijack()
    await session.transport.handleRequest(req.raw, reply.raw)
  })

  app.delete('/', async (req, reply) => {
    const { session, error } = loadOwnSession(req)
    if (error === 'forbidden') {
      return reply.forbidden('This MCP session belongs to a different API key.')
    }
    if (!session) {
      return reply.notFound('No MCP session with this id.')
    }
    reply.hijack()
    await session.transport.handleRequest(req.raw, reply.raw)
  })
}

export default routes
