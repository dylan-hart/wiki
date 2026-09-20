import type { McpServer, CallToolResult } from '@modelcontextprotocol/server'
import { McpToolError, type McpAuthContext, type McpAuthContextGetter } from '../auth.ts'
import { toResult } from './shared.ts'

/**
 * Wraps the same `CARDINAL.models.locales.sideloadFromDataPath({ force: true })` that
 * `POST /_api/locales/sideload` (`api/locales.ts`) calls — every file found is reloaded regardless of
 * its last-modified time, as on the route.
 */
export async function handleSideloadLocales(ctx: McpAuthContext): Promise<CallToolResult> {
  if (!ctx.permissions.includes('manage:system')) {
    throw new McpToolError('You are not allowed to sideload locales.')
  }

  const result = await CARDINAL.models.locales.sideloadFromDataPath({ force: true })
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
