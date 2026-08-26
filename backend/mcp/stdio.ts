/**
 * MCP server, stdio transport.
 *
 * Run via `node backend/mcp/stdio.ts` from the repo root (same convention as `node backend`, and as
 * `node backend/tasks/migrate.ts`) — never imported by `index.ts`. An MCP client (Claude Desktop, an
 * IDE, `npx @modelcontextprotocol/inspector`, …) spawns this as a child process and speaks JSON-RPC
 * over its stdin/stdout, which is why it cannot run inside the same process as the Fastify app: that
 * process's own stdout already carries request logs (`core/logger.ts`), and the two would corrupt each
 * other's framing on the same stream. See `mcp/bootstrap.ts`'s doc comment for why this is still "the
 * `backend/mcp/` module registered alongside the existing Fastify app" the work package asks for, in
 * every sense except the one the transport itself forces apart.
 *
 * This is the lightweight local/desktop-client entrypoint, not a second deployment artifact: the
 * reference/production way to reach this wiki's MCP tools is `mcp/http.ts`, mounted in-process on the
 * very same Fastify app `node backend` already runs — see that file's own doc comment. Nobody stands up
 * a second image or container for either transport; both live in this one `backend/` workspace and
 * share the same models/schema/database, differing only in which OS process's stdio a client attaches
 * to.
 *
 * Auth: reads a single bearer token from `WIKI_MCP_API_KEY` (mint one via the existing API Keys admin
 * screen, or `POST /_api/system/api-keys`) and verifies it once at startup — refusing to start at all
 * on an invalid/revoked/expired key, rather than failing the first tool call. Every tool call acts as
 * that one key's identity, but the identity itself is NOT frozen at boot the way it once was: a
 * background timer (`mcp/stdioReverify.ts`) re-runs `authenticateApiKey()` roughly every 30 seconds and
 * refreshes it, so a key revoked, expired, regrouped or deactivated after this process started stops
 * being honored on the next tick, not only when the process itself is restarted. See `mcp/auth.ts`'s
 * `McpAuthContext` doc comment for exactly what the identity resolves to — a personal access token here
 * grants the same per-user page-rule authorization as it does over `mcp/http.ts`, just re-verified on a
 * short timer instead of on every single request the way the HTTP transport can afford to.
 */

// -> MUST run before anything below logs a single line: `core/logger.ts` and various boot-path
//    fallbacks write through `console.log`/`console.info`, and the stdio transport needs stdout free
//    for JSON-RPC frames only. `console.error` (already used for genuine failures throughout
//    `core/config.ts`/`core/db.ts`) is left alone — stderr is exactly where an MCP client expects a
//    misbehaving server's diagnostics to go.
console.log = console.error.bind(console)
console.info = console.error.bind(console)

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { bootstrapMcpRuntime } from './bootstrap.ts'
import { auditActorFor, authenticateApiKey } from './auth.ts'
import { createMcpServer } from './server.ts'
import { createReverifyingContext } from './stdioReverify.ts'
import { registerAllTools } from './tools/index.ts'

/**
 * Closes the db pool (if it was ever opened) and exits. The one path off this process: a startup
 * failure before the pool exists, the client disconnecting, or a signal — all funnel through here so
 * none of them leaves an open `pg` pool holding the event loop, or a process exit that skips it. Same
 * reasoning `tasks/migrate.ts` documents for its own cleanup `finally`.
 */
async function shutdown(code: number): Promise<never> {
  // -> `WIKI` is declared non-nullable (`types/global.d.ts`), but genuinely is not yet assigned when
  //    this runs before `bootstrapMcpRuntime()` (the missing-`WIKI_MCP_API_KEY` early exit) — `typeof`
  //    is the one check that is safe to make of a possibly-unset `var` without the type checker
  //    treating it as always true.
  if (typeof WIKI !== 'undefined') {
    await WIKI.dbManager?.pool?.end()
  }
  process.exit(code)
}

async function main(): Promise<void> {
  const token = process.env.WIKI_MCP_API_KEY?.trim()
  if (!token) {
    console.error(
      'WIKI_MCP_API_KEY is not set. Mint an API key for this server to use (Admin > API Keys, or ' +
        'POST /_api/system/api-keys) and set it in the MCP client config that launches this process.'
    )
    await shutdown(1)
    return
  }

  const WIKI = await bootstrapMcpRuntime('mcp-stdio')

  let ctx
  try {
    ctx = await authenticateApiKey(token)
  } catch (err: any) {
    console.error(err.message)
    await shutdown(1)
    return
  }

  // -> #1118: this process IS the session for its whole lifetime (unlike `mcp/http.ts`, which opens
  //   one per `initialize` request) -- logged once, right after the one auth check above succeeds, so
  //   it lands in the audit log exactly like an HTTP session's own `mcp.sessionOpened` entry does. No
  //   `req`/IP to read here (this transport has no HTTP request), hence no `actorIp`.
  await WIKI.models.auditLog.record({
    event: 'mcp.sessionOpened',
    actor: auditActorFor(ctx),
    targetType: 'apiKey',
    targetId: ctx.keyId,
    targetLabel: `API Key ${ctx.keyId}`,
    detail: { transport: 'stdio' },
    siteId: ctx.siteId
  })

  const server = createMcpServer(WIKI.version)
  // -> Re-verified on a short timer rather than fixed for the process's whole lifetime — see
  //    `mcp/stdioReverify.ts`'s doc comment and `McpAuthContextGetter`'s in `mcp/auth.ts`. A key that
  //    stops verifying (revoked, expired, or the model call itself errors) shuts this process down
  //    through the same `shutdown()` path a startup failure uses.
  const reverifying = createReverifyingContext(token, ctx, async (err: any) => {
    console.error(`The MCP API key stopped verifying: ${err.message}`)
    await shutdown(1)
  })
  registerAllTools(server, reverifying.getCtx)

  const transport = new StdioServerTransport()
  // -> The client closes stdin when it disconnects; the SDK's transport surfaces that as `onclose`
  //    rather than the process exiting on its own, so this is what actually ends the process.
  transport.onclose = () => {
    reverifying.stop()
    void shutdown(0)
  }
  await server.connect(transport)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(0))
}

main().catch((err) => {
  console.error(err)
  void shutdown(1)
})
