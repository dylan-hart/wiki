import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { McpToolError, type McpAuthContext, type McpAuthContextGetter } from '../auth.ts'
import { toResult } from './shared.ts'

/**
 * Rescan `<dataPath>/icons/` for vendored Iconify collection JSON files and load them into the DB —
 * the MCP-facing wrapper around `POST /_api/icons/sideload` (`api/icons.ts`), for an agent that
 * needs to trigger an offline icon-set reload without going through the REST surface directly.
 * Delegates to the exact same model call the REST route makes,
 * `WIKI.models.icons.sideloadFromDataPath()` — no arguments, unlike `sideload_locales`'s
 * `{ force: true }`: icon sideload has no freshness gate to force past in the first place (see that
 * method's own doc comment in `models/icons.ts`), so every file found there is always re-loaded.
 *
 * Same hard gate as `sideload_locales`: the REST route declares `permissions: ['manage:system']`
 * with no lesser-privilege path at all, so a caller lacking it is refused outright.
 */
export async function handleSideloadIcons(ctx: McpAuthContext): Promise<CallToolResult> {
  if (!ctx.permissions.includes('manage:system')) {
    throw new McpToolError('You are not allowed to sideload icon sets.')
  }

  const result = await WIKI.models.icons.sideloadFromDataPath()
  return toResult(result)
}

export function registerSideloadIconsTool(server: McpServer, getCtx: McpAuthContextGetter): void {
  server.registerTool(
    'sideload_icons',
    {
      description:
        'Rescan `<dataPath>/icons/` on the server for vendored Iconify collection JSON files and load them into the database — the offline-mode path for adding or updating an icon set against a running instance with no rebuild, redeploy, or network access. Always re-loads every file found there. Requires `manage:system`.',
      inputSchema: {}
    },
    () => handleSideloadIcons(getCtx())
  )
}
