import type { McpServer, CallToolResult } from '@modelcontextprotocol/server'
import { McpToolError, type McpAuthContext, type McpAuthContextGetter } from '../auth.ts'
import { toResult } from './shared.ts'

/**
 * Wraps the same `CARDINAL.models.icons.sideloadFromDataPath()` that `POST /_api/icons/sideload`
 * (`api/icons.ts`) calls. No arguments, unlike `sideload_locales`'s `{ force: true }`: icon sideload
 * has no freshness gate to force past, so every file found is always re-loaded.
 */
export async function handleSideloadIcons(ctx: McpAuthContext): Promise<CallToolResult> {
  if (!ctx.permissions.includes('manage:system')) {
    throw new McpToolError('You are not allowed to sideload icon sets.')
  }

  const result = await CARDINAL.models.icons.sideloadFromDataPath()
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
