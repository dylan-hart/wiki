import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { actorFor, McpToolError, type McpAuthContext, type McpAuthContextGetter } from '../auth.ts'
import { resolveRequestedSite } from '../site.ts'
import { siteIdArg, toResult } from './shared.ts'

const watchPageInputSchema = {
  pageId: z
    .string()
    .uuid()
    .describe('The page to watch. See `search_pages`/`get_page` for the id.'),
  siteId: siteIdArg('Which site the page belongs to.', 'Omit on a single-site instance.'),
  notifyMode: z
    .enum(['immediate', 'digest'])
    .optional()
    .describe(
      'How to be told about changes: one mail per change, or batched into a digest. Only takes effect on the FIRST watch -- use `set_page_watch_preference` to change it on a watch that already exists.'
    ),
  notifyOnEdited: z
    .boolean()
    .optional()
    .describe('Hear about edits to the page. Defaults to true; also first-watch-only, as above.'),
  notifyOnMoved: z
    .boolean()
    .optional()
    .describe(
      'Hear about the page being moved/renamed. Defaults to true; also first-watch-only, as above.'
    ),
  notifyOnDeleted: z
    .boolean()
    .optional()
    .describe(
      'Hear about the page being deleted. Defaults to true; also first-watch-only, as above.'
    )
}

export interface WatchPageArgs {
  pageId: string
  siteId?: string
  notifyMode?: 'immediate' | 'digest'
  notifyOnEdited?: boolean
  notifyOnMoved?: boolean
  notifyOnDeleted?: boolean
}

/**
 * Start watching a page, gated exactly like `PUT /_api/sites/:siteId/pages/:pageId/watch`
 * (`api/watching.ts`): logged in, and `read:pages` on the page -- the same test as reading it, since
 * watching is "read this page, and tell me when it changes", nothing more. Watching is not itself a
 * page-rule permission (see CLAUDE.md's Permissions section), so this checks `ctx.userId` directly
 * rather than going through `pageActorFor()` the way `create_page`/`update_page` do -- there is no
 * page-author attribution to build here, only an account to record the watch against.
 *
 * A password does not gate this, mirroring the REST route's own comment: a watcher is asking to be
 * told the page changed, not to read what it says.
 */
export async function handleWatchPage(
  ctx: McpAuthContext,
  args: WatchPageArgs
): Promise<CallToolResult> {
  const site = resolveRequestedSite(ctx, args.siteId)
  if (!ctx.userId) {
    throw new McpToolError(
      'Watching a page requires a personal access token -- watching belongs to an account, and an admin-issued key has none to watch as.'
    )
  }

  const actor = actorFor(ctx)
  const page = await WIKI.models.pages.getPage({ siteId: site.id, id: args.pageId })
  // -> Not readable is indistinguishable from not there, same as `loadReadablePage()` in
  //    `helpers/pageAccess.ts`
  if (!page || !WIKI.models.groups.checkAccess(actor, 'read:pages', { ...page, siteId: site.id })) {
    throw new McpToolError('This page does not exist.')
  }

  await WIKI.models.pageWatching.watch({
    siteId: site.id,
    pageId: page.id,
    userId: ctx.userId,
    notifyMode: args.notifyMode,
    notifyOnEdited: args.notifyOnEdited,
    notifyOnMoved: args.notifyOnMoved,
    notifyOnDeleted: args.notifyOnDeleted
  })
  const preference = await WIKI.models.pageWatching.getPreference(page.id, ctx.userId)

  return toResult({ pageId: page.id, isWatching: true, preference })
}

export function registerWatchPageTool(server: McpServer, getCtx: McpAuthContextGetter): void {
  server.registerTool(
    'watch_page',
    {
      description:
        'Start watching a page for changes. Requires a personal access token and `read:pages` on the page. Watching a page already watched is a no-op that leaves any existing preference alone -- an optional delivery preference passed here only takes effect the first time the page is watched; use `set_page_watch_preference` to change it afterwards.',
      inputSchema: watchPageInputSchema
    },
    (args) => handleWatchPage(getCtx(), args)
  )
}
