/* eslint-disable no-console -- stdout must stay pure JSON-RPC; the redirects below are exactly what keeps it that way. */
/**
 * MCP server, stdio transport. Run via `node backend/mcp/stdio.ts` from the repo root: an MCP client
 * spawns it as a child process and speaks JSON-RPC over its stdin/stdout. It cannot share the Fastify
 * process, whose stdout already carries logs that would corrupt the JSON-RPC framing. `mcp/http.ts`
 * is the in-process transport over the same models and database.
 *
 * Auth: one bearer token from `WIKI_MCP_API_KEY`, verified at startup (an invalid key refuses to
 * start). It is then re-verified both on a timer (`mcp/stdioReverify.ts`, so revocation is caught
 * while idle) and before every `tools/call` (`reverifyOnToolCall`, so a call right after revocation
 * is refused), feeding one cached `McpAuthContext`. A key that stops verifying shuts the process
 * down; a permission removed from the owner's groups stops being honoured on the next call.
 */

import { pathToFileURL } from 'node:url'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { isJSONRPCRequest, type Transport } from '@modelcontextprotocol/server'
import { bootstrapMcpRuntime } from './bootstrap.ts'
import { auditActorFor, authenticateApiKey } from './auth.ts'
import type { McpAuthContext } from './auth.ts'
import { createMcpServer } from './server.ts'
import { createReverifyingContext } from './stdioReverify.ts'
import { registerAllTools } from './tools/index.ts'

/**
 * False when another module (a test) imports this file for its exports: the console redirects,
 * signal handlers and `main()` are gated on it so an import has no side effects.
 */
const isEntryPoint = import.meta.url === pathToFileURL(process.argv[1] ?? '').href

if (isEntryPoint) {
  // -> Must run before anything logs: `core/logger.ts` and boot-path fallbacks write through
  //    `console.log`/`console.info`. stderr is where an MCP client expects diagnostics.
  console.log = console.error.bind(console)
  console.info = console.error.bind(console)
}

/**
 * Every exit (startup failure, client disconnect, signal) funnels through here so the db pool is
 * always closed first.
 */
async function shutdown(code: number): Promise<never> {
  // -> `CARDINAL` is typed non-nullable but is unassigned before `bootstrapMcpRuntime()` (the
  //    missing-`WIKI_MCP_API_KEY` exit); `typeof` is the one check the type checker does not treat
  //    as always true.
  if (typeof CARDINAL !== 'undefined') {
    await CARDINAL.dbManager?.pool?.end()
  }
  process.exit(code)
}

/**
 * The stdio counterpart to `mcp/http.ts`'s per-request `onRequest` re-verify: a stdio session has no
 * request boundary to hook, so this wraps `transport.onmessage` and re-verifies `token` before every
 * `tools/call`. Must run AFTER `server.connect(transport)`, which installs the SDK dispatch captured
 * here. Other messages pass through unexamined: none depends on the caller's grants.
 *
 * On a failed re-verify the message is not forwarded and `onVerifyFailed` runs instead: the identity
 * the whole process is authorized as can no longer be trusted, not just the one call.
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

  const CARDINAL = await bootstrapMcpRuntime('mcp-stdio')

  let ctx: McpAuthContext
  try {
    ctx = await authenticateApiKey(token)
  } catch (err: any) {
    console.error(err.message)
    await shutdown(1)
    return
  }

  // -> This process is the session for its whole lifetime (`mcp/http.ts` opens one per `initialize`),
  //   so it is audited once here. This transport has no HTTP request, hence no `actorIp`.
  await CARDINAL.models.auditLog.record({
    event: 'mcp.sessionOpened',
    actor: auditActorFor(ctx),
    targetType: 'apiKey',
    targetId: ctx.keyId,
    targetLabel: `API Key ${ctx.keyId}`,
    detail: { transport: 'stdio' },
    siteId: ctx.siteId
  })

  const server = createMcpServer(CARDINAL.version)
  const reverifying = createReverifyingContext(token, ctx, async (err: any) => {
    console.error(`The MCP API key stopped verifying: ${err.message}`)
    await shutdown(1)
  })
  registerAllTools(server, reverifying.getCtx)

  const transport = new StdioServerTransport()
  // -> The client closes stdin when it disconnects; the SDK surfaces that as `onclose` rather than
  //    exiting, so this is what ends the process.
  transport.onclose = () => {
    reverifying.stop()
    void shutdown(0)
  }
  await server.connect(transport)
  // -> Must run after `connect()`, which installs the `onmessage` dispatch this wraps.
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
