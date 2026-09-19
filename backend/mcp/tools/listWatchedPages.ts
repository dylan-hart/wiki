import type { McpServer, CallToolResult } from '@modelcontextprotocol/server'
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
 * Authed on `ctx.userId` directly rather than through `pageActorFor()`: a watch is not a page-rule
 * grant, so the only question is whether there is a real user whose watch list this would be.
 *
 * `listForUser()` re-checks `read:pages` per row against each page's current state, so a page the
 * caller's groups have since lost drops out on its own and nothing further is filtered here.
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
  const pages = await CARDINAL.models.pageWatching.listForUser(site.id, ctx.userId)
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
