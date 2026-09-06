/* eslint-disable no-console -- stdout must stay pure JSON-RPC; the redirects below are exactly what keeps it that way. */
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
 * on an invalid/revoked/expired key, rather than failing the first tool call. The identity itself is
 * NOT then frozen for the rest of the process the way it once was (OpenProject #2197), through two
 * layered re-verifications of the same token that both feed the same cached `McpAuthContext`:
 *
 *  - A background timer (`mcp/stdioReverify.ts`) re-runs `authenticateApiKey()` roughly every 30
 *    seconds regardless of activity, so a key revoked, expired, regrouped or deactivated is caught
 *    even during a long idle stretch with no tool calls in flight.
 *  - Every `tools/call` message additionally re-runs the same verification (`reverifyOnToolCall`
 *    below) before it is allowed to reach a tool handler, exactly mirroring what
 *    `mcp/http.ts:76`/`:149` already does per HTTP request — this is what guarantees a call made the
 *    instant after a revocation is refused rather than riding out the rest of the timer's interval.
 *
 * A key revoked or expired after boot fails whichever check catches it first and takes the whole
 * process down through `shutdown()` rather than being honoured for one more call; a personal access
 * token whose owner's group membership merely changed re-verifies fine but with a smaller
 * `McpAuthContext`, so a permission removed after boot stops being honoured on the very next call
 * without needing a restart. See `mcp/auth.ts`'s `McpAuthContext` doc comment for exactly what a
 * verified token resolves to — a personal access token here grants the same per-user page-rule
 * authorization as it does over `mcp/http.ts`.
 */

import { pathToFileURL } from 'node:url'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { isJSONRPCRequest } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { bootstrapMcpRuntime } from './bootstrap.ts'
import { auditActorFor, authenticateApiKey } from './auth.ts'
import type { McpAuthContext } from './auth.ts'
import { createMcpServer } from './server.ts'
import { createReverifyingContext } from './stdioReverify.ts'
import { registerAllTools } from './tools/index.ts'

/**
 * True only when this file is the process's actual entry point (`node backend/mcp/stdio.ts`), false
 * when another module `import`s it — `stdio.test.ts` does exactly that, to reach `reverifyOnToolCall`
 * without a real MCP client to spawn this as a child process against. Everything below that behaves
 * like a running CLI server (silencing `console.log`/`console.info`, installing signal handlers, and
 * actually calling `main()`) is gated on this, so importing this module for its exports has no
 * side effects of its own.
 */
const isEntryPoint = import.meta.url === pathToFileURL(process.argv[1] ?? '').href

if (isEntryPoint) {
  // -> MUST run before anything below logs a single line: `core/logger.ts` and various boot-path
  //    fallbacks write through `console.log`/`console.info`, and the stdio transport needs stdout free
  //    for JSON-RPC frames only. `console.error` (already used for genuine failures throughout
  //    `core/config.ts`/`core/db.ts`) is left alone — stderr is exactly where an MCP client expects a
  //    misbehaving server's diagnostics to go.
  console.log = console.error.bind(console)
  console.info = console.error.bind(console)
}

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

/**
 * Wraps `transport.onmessage` so every `tools/call` request re-verifies `token` before it reaches the
 * SDK's own dispatch (installed by `server.connect(transport)`, which this must therefore run AFTER —
 * `Protocol#connect` chains onto whatever `onmessage` was already there rather than clobbering it, so
 * capturing it here is exactly the SDK's own dispatch chain). This is the stdio counterpart to
 * `mcp/http.ts`'s `onRequest` hook: that transport gets a real per-request hook from Fastify, and this
 * one has no such hook of its own to lean on, since a stdio session is a single long-lived connection
 * with no request/response boundary the transport surfaces — wrapping `onmessage` is what recovers one.
 *
 * A message that is not a `tools/call` request (`initialize`, `tools/list`, a notification, a response
 * to a server-initiated request, …) passes straight through unexamined — none of those depend on the
 * caller's page-rule grants the way a tool call does.
 *
 * On a successful re-verify, `applyCtx` is called with the fresh `McpAuthContext` before the message is
 * forwarded, so the tool handler that runs moments later reads the just-updated identity (see
 * `McpAuthContextGetter`'s doc comment in `mcp/auth.ts`) — this is what makes a permission dropped from
 * the owner's group after boot stop being honoured on the very next call. On a failed re-verify (a
 * revoked/expired key), the message is NOT forwarded — the tool call never reaches a handler — and
 * `onVerifyFailed` runs instead, which `main()` wires to the same `shutdown()` path a bad key at
 * startup already takes: a re-verify failure means the identity this whole process is authorized as can
 * no longer be trusted, not just the one call in flight.
 *
 * Exported for `stdio.test.ts`: a real `StdioServerTransport` talks to actual stdin/stdout, which a
 * unit test has no good way to attach to, so the test drives this against a minimal stub transport and
 * injects its own `applyCtx`/`onVerifyFailed` spies instead of the real `shutdown()`.
 */
export function reverifyOnToolCall(
  transport: Pick<Transport, 'onmessage'>,
  token: string,
  applyCtx: (ctx: McpAuthContext) => void,
  onVerifyFailed: (err: any) => Promise<void> | void
): void {
  const dispatch = transport.onmessage

  transport.onmessage = ((message: unknown, extra?: unknown) => {
    void handle(message, extra)
  }) as Transport['onmessage']

  async function handle(message: unknown, extra?: unknown): Promise<void> {
    if (isJSONRPCRequest(message) && message.method === 'tools/call') {
      try {
        applyCtx(await authenticateApiKey(token))
      } catch (err: any) {
        console.error(`Re-verifying the MCP API key failed on a tool call: ${err.message}`)
        await onVerifyFailed(err)
        return
      }
    }
    ;(dispatch as any)?.(message, extra)
  }
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

  let ctx: McpAuthContext
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
  //    through the same `shutdown()` path a startup failure uses. `reverifying.setCtx` is also fed by
  //    `reverifyOnToolCall` below, so `getCtx()` always reads whichever of the two re-verifications
  //    (timer tick or tool call) most recently resolved.
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
  // -> Must run AFTER `connect()`, which is what installs the SDK's own `onmessage` dispatch this
  //    wraps — see `reverifyOnToolCall`'s doc comment.
  reverifyOnToolCall(
    transport,
    token,
    (fresh) => {
      reverifying.setCtx(fresh)
    },
    () => shutdown(1)
  )
}

if (isEntryPoint) {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown(0))
  }

  main().catch((err) => {
    console.error(err)
    void shutdown(1)
  })
}
