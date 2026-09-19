import { z } from 'zod'
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server'
import {
  actorFor,
  pageActorFor,
  McpToolError,
  type McpAuthContext,
  type McpAuthContextGetter
} from '../auth.ts'
import { resolveRequestedSite } from '../site.ts'
import { siteIdArg, toResult } from './shared.ts'

/** Duplicates `api/watching.ts#DEFAULT_WATCHER_LIMIT`: each surface owns its own default. */
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
 * Who watches a page is readable by anybody who may read the page itself, signed in or not, as on
 * `GET /_api/sites/:siteId/pages/:pageId/watchers` (`api/watching.ts`). The gate replays
 * `helpers/pageAccess.ts#requireReadablePage`'s check order by hand — there is no `FastifyReply` here
 * to delegate to — refusing missing and unreadable identically so a caller cannot tell them apart.
 */
export async function handleListPageWatchers(
  ctx: McpAuthContext,
  args: ListPageWatchersArgs
): Promise<CallToolResult> {
  const site = resolveRequestedSite(ctx, args.siteId)
  const actor = actorFor(ctx)

  const page = await CARDINAL.models.pages.getPage({
    siteId: site.id,
    id: args.pageId,
    // -> Mirrors `actorFrom(req)` on the REST route: a key with no user behind it is an anonymous
    //    reader, restricted to published pages.
    publicOnly: !pageActorFor(ctx),
    // -> Whoever may write or manage the page is not stopped by its own password
    unlocked: (unlockRef) =>
      CARDINAL.models.groups.checkAccess(actor, 'write:pages', { ...unlockRef, siteId: site.id }) ||
      CARDINAL.models.groups.checkAccess(actor, 'manage:pages', { ...unlockRef, siteId: site.id }),
    withPassword: false
  })

  if (
    !page ||
    !CARDINAL.models.groups.checkAccess(actor, 'read:pages', { ...page, siteId: site.id })
  ) {
    throw new McpToolError('This page does not exist.')
  }
  if (page.isLocked) {
    throw new McpToolError('This page is password protected.')
  }

  const watchers = await CARDINAL.models.pageWatching.listForPage(page.id, {
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
