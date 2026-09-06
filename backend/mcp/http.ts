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
 *
 * That map is capped and idle-expiring (OpenProject #2207, security/09-dos-resource §7), not a plain
 * unbounded `Map`: the only insertion was `onsessioninitialized` and the only removal was
 * `transport.onclose` (itself only ever fired by an explicit `DELETE`), so nothing swept an entry a
 * client abandoned by crashing or losing its network, and `limitApiKey`'s 300-requests-per-5-minutes
 * ceiling still let a single low-privilege key open on the order of 80,000 sessions a day. `sessions`
 * is now an `LRUCache` — `updateAgeOnGet` so the idle clock restarts on every request against a session
 * still in genuine use (every handler below reads a session via `.get()` before doing anything else),
 * `max` so a sustained flood evicts the longest-idle entry rather than growing forever, and `dispose`
 * closes the evicted entry's transport so the SDK's own cleanup still runs for a session nothing ever
 * called `DELETE` on.
 */

import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { LRUCache } from 'lru-cache'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { limitApiKey } from '../helpers/rateLimit.ts'
import { actorFromRequest } from '../models/auditLog.ts'
import { contextFromIdentity, type McpAuthContext } from './auth.ts'
import { createMcpServer } from './server.ts'
import { registerAllTools } from './tools/index.ts'

interface McpSession {
  transport: StreamableHTTPServerTransport
  /** The key that opened this session — a later request naming this session must be the same key. */
  keyId: string
  /**
   * The identity every tool call on this session is currently authorized against. Mutable, and
   * updated to that request's own freshly-verified context right before each POST is dispatched (see
   * the `onRequest` hook above and `McpAuthContextGetter`'s doc comment in `mcp/auth.ts`) — a session
   * living longer than one request must not keep authorizing every later call against however things
   * stood when it was opened.
   */
  ctx: McpAuthContext
}

/** A session idle this long (no request naming it) is evicted -- see the file header comment. */
const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60 * 1000

/** Hard cap on live sessions; once exceeded, the longest-idle entry is evicted first. */
const DEFAULT_SESSION_CAP = 1000

interface HttpRoutesOptions {
  /** Test-only override for `DEFAULT_SESSION_IDLE_TTL_MS`, so a suite need not wait 30 real minutes. */
  sessionIdleTtlMs?: number
  /** Test-only override for `DEFAULT_SESSION_CAP`, so a suite need not open 1000 real sessions. */
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
    //    it, so this restarts the ttl clock on every request against a session still genuinely in use.
    updateAgeOnGet: true,
    // -> Only an automatic eviction (cap exceeded or ttl expired) needs the transport closed here — an
    //    explicit `sessions.delete()` below (DELETE /, or the transport's own `onclose` firing after
    //    the SDK itself already tore it down) means the transport is already closing/closed, and
    //    calling `close()` on it again would be redundant at best.
    dispose: (session, _sessionId, reason) => {
      if (reason === 'delete') {
        return
      }
      Promise.resolve(session.transport.close()).catch((err: any) => {
        WIKI.logger.debug('mcp', "closing an evicted session's transport failed", { error: err })
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
      identity = await WIKI.models.apiKeys.verify(token)
    } catch (err: any) {
      // -> `warn`, not `debug` (V8): a refused credential is security-relevant, and at `debug` an
      //    operator could not see it at all in a production deployment.
      WIKI.logger.warn('mcp', 'bearer token refused', { error: err })
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
      const newSession: McpSession = { transport: undefined as any, keyId: ctx.keyId, ctx }
      // -> Tools read the identity through `newSession.ctx`, not the `ctx` captured above, so a later
      //    request on this same session (below) authorizes against ITS OWN fresh verification rather
      //    than whichever identity happened to open the session.
      registerAllTools(server, () => newSession.ctx)
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: async (sid) => {
          sessions.set(sid, newSession)
          // -> #1118: the one place an MCP session over HTTP actually comes into being. `actorFromRequest`
          //   reads `req.apiKey` (set by the `onRequest` hook above) the same way it does for every other
          //   apiKey-authenticated `/_api/` request, so this entry is attributed identically to those.
          await WIKI.models.auditLog.record({
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

    // -> Refresh the session's identity to this request's own verification before dispatching — see
    //    `McpSession.ctx`'s doc comment. A no-op for the branch above (already `ctx`), and what makes a
    //    revoked/regrouped personal access token stop granting what it used to on the very next call
    //    of an existing session, not only once the session itself is torn down.
    session.ctx = ctx

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
    // -> Same refresh as the POST handler — see `McpSession.ctx`'s doc comment.
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
