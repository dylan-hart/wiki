import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { McpToolError, type McpAuthContext, type McpAuthContextGetter } from '../auth.ts'
import { toResult } from './shared.ts'

/**
 * Rescan `<dataPath>/locales/` for locale-pack JSON files and load them into the DB — the MCP-facing
 * wrapper around `POST /_api/locales/sideload` (`api/locales.ts`), for an agent that needs to trigger
 * an offline locale reload without going through the REST surface directly. Delegates to the exact
 * same model call the REST route makes, `WIKI.models.locales.sideloadFromDataPath({ force: true })` —
 * always force-reloading every file found there, regardless of its last-modified time, same as the
 * route.
 *
 * Unlike `render_diagram`, which only uses `manage:system` to exempt a caller from its rate limit,
 * this is a hard gate: the REST route declares `permissions: ['manage:system']` with no lesser-
 * privilege path at all, so a caller lacking it is refused outright rather than falling through to
 * some narrower behavior.
 */
export async function handleSideloadLocales(ctx: McpAuthContext): Promise<CallToolResult> {
  if (!ctx.permissions.includes('manage:system')) {
    throw new McpToolError('You are not allowed to sideload locales.')
  }

  const result = await WIKI.models.locales.sideloadFromDataPath({ force: true })
  return toResult(result)
}

export function registerSideloadLocalesTool(server: McpServer, getCtx: McpAuthContextGetter): void {
  server.registerTool(
    'sideload_locales',
    {
      description:
        'Rescan `<dataPath>/locales/` on the server for locale-pack JSON files and load them into the database — the offline-mode path for adding or updating a locale with no rebuild, redeploy, or network access. Always force-reloads every file found there. Requires `manage:system`.',
      inputSchema: {}
    },
    () => handleSideloadLocales(getCtx())
  )
}
