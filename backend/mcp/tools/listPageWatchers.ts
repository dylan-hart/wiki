import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  actorFor,
  pageActorFor,
  McpToolError,
  type McpAuthContext,
  type McpAuthContextGetter
} from '../auth.ts'
import { resolveRequestedSite } from '../site.ts'
import { siteIdArg, toResult } from './shared.ts'

/**
 * How many watchers this tool returns when the caller does not say — matches
 * `api/watching.ts#DEFAULT_WATCHER_LIMIT`. Not a shared export: each surface owns its own default for
 * the same reason that one does (see its doc comment), and there is no third caller to justify a
 * shared constant yet.
 */
const DEFAULT_WATCHER_LIMIT = 25

const listPageWatchersInputSchema = {
  pageId: z
    .string()
    .uuid()
    .describe('The page whose watchers to list. See `search_pages`/`get_page` for the id.'),
  siteId: siteIdArg('Which site the page belongs to.', 'Omit on a single-site instance.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'How many watchers to return, oldest first. `total` in the result counts every watcher regardless of this cap. 25 when omitted.'
    )
}

export interface ListPageWatchersArgs {
  pageId: string
  siteId?: string
  limit?: number
}

/**
 * List who is watching a page — wraps `WIKI.models.pageWatching.listForPage(pageId, { limit })`, the
 * same model method `GET /_api/sites/:siteId/pages/:pageId/watchers` (`api/watching.ts`) calls.
 *
 * Stays open/no-auth, mirroring that route: who watches a page is readable by anybody who may read
 * the page itself (`read:pages`), signed in or not, which is a different question from watching one —
 * see `list_watched_pages`'s own doc comment for that side. The gate replicates
 * `helpers/pageAccess.ts#requireReadablePage`'s check order by hand (there is no `FastifyReply` here
 * to delegate to): missing-or-unreadable first, refused identically either way so a caller cannot
 * distinguish "does not exist" from "exists but you may not read it"; a still-locked page refused
 * last, and only for a caller who may not bypass the password (`write:pages`/`manage:pages` on the
 * page) — there is no session here to have already satisfied an unlock, unlike the REST route.
 */
export async function handleListPageWatchers(
  ctx: McpAuthContext,
  args: ListPageWatchersArgs
): Promise<CallToolResult> {
  const site = resolveRequestedSite(ctx, args.siteId)
  const actor = actorFor(ctx)

  const page = await WIKI.models.pages.getPage({
    siteId: site.id,
    id: args.pageId,
    // -> Mirrors `actorFrom(req)` on the REST route: no attributable user behind the key means an
    //    anonymous reader, restricted to published pages, same as `get_page`.
    publicOnly: !pageActorFor(ctx),
    // -> Whoever may write or manage the page is not stopped by its own password — the same
    //    `mayBypassPassword` question `get_page` asks, with no session-based unlock to also honor.
    unlocked: (unlockRef) =>
      WIKI.models.groups.checkAccess(actor, 'write:pages', { ...unlockRef, siteId: site.id }) ||
      WIKI.models.groups.checkAccess(actor, 'manage:pages', { ...unlockRef, siteId: site.id }),
    withPassword: false
  })

  if (!page || !WIKI.models.groups.checkAccess(actor, 'read:pages', { ...page, siteId: site.id })) {
    throw new McpToolError('This page does not exist.')
  }
  if (page.isLocked) {
    throw new McpToolError('This page is password protected.')
  }

  const watchers = await WIKI.models.pageWatching.listForPage(page.id, {
    limit: args.limit ?? DEFAULT_WATCHER_LIMIT
  })
  return toResult(watchers)
}

export function registerListPageWatchersTool(
  server: McpServer,
  getCtx: McpAuthContextGetter
): void {
  server.registerTool(
    'list_page_watchers',
    {
      description:
        'Who is watching a wiki page, oldest watcher first, with the total across all of them. Readable by anybody who may read the page, signed in or not.',
      inputSchema: listPageWatchersInputSchema
    },
    (args) => handleListPageWatchers(getCtx(), args)
  )
}
