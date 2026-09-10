import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { McpToolError, type McpAuthContext, type McpAuthContextGetter } from '../auth.ts'
import { resolveRequestedSite } from '../site.ts'
import { siteIdArg, toResult } from './shared.ts'

const listWatchedPagesInputSchema = {
  siteId: siteIdArg('Which site to list the watch list for.')
}

export interface ListWatchedPagesArgs {
  siteId?: string
}

/**
 * List the pages the caller is watching on a site, most recently watched first. Wraps
 * `WIKI.models.pageWatching.listForUser(siteId, userId)` — the same model method
 * `GET /_api/sites/:siteId/watching` (`api/watching.ts`) calls, and, like that route, requires nothing
 * beyond being logged in: everything it returns is the caller's own.
 *
 * Actor-authed directly on `ctx.userId`, not through `pageActorFor()` — a watch is not a page-rule
 * grant, so there is no `write:pages`-shaped permission to check here, only whether there is a real
 * user to list a watch list FOR. An admin-issued key has none (`ctx.userId` is null), and is refused
 * with the same "requires a personal access token" wording the write tools (`create_page`/
 * `update_page`) use for the same underlying reason, rather than a differently-worded read-tool
 * refusal.
 *
 * `listForUser()` already re-checks `read:pages` per row against each page's CURRENT state
 * (OpenProject #2173 — see its own doc comment), so a page the caller's groups have since lost simply
 * drops out of the list; nothing further is filtered here.
 */
export async function handleListWatchedPages(
  ctx: McpAuthContext,
  args: ListWatchedPagesArgs
): Promise<CallToolResult> {
  const site = resolveRequestedSite(ctx, args.siteId)
  if (!ctx.userId) {
    throw new McpToolError(
      'Listing watched pages requires a personal access token — an admin-issued key has no user whose watch list this would be.'
    )
  }
  const pages = await WIKI.models.pageWatching.listForUser(site.id, ctx.userId)
  return toResult(pages)
}

export function registerListWatchedPagesTool(
  server: McpServer,
  getCtx: McpAuthContextGetter
): void {
  server.registerTool(
    'list_watched_pages',
    {
      description:
        "The caller's own watch list on a site, most recently watched first. Requires a personal access token — the watch list belongs to its owner.",
      inputSchema: listWatchedPagesInputSchema
    },
    (args) => handleListWatchedPages(getCtx(), args)
  )
}
