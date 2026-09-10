import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { McpToolError, type McpAuthContext, type McpAuthContextGetter } from '../auth.ts'
import { resolveRequestedSite } from '../site.ts'
import type { WatchNotifyPreference } from '../../models/pageWatching.ts'
import { siteIdArg, toResult } from './shared.ts'

const setPageWatchPreferenceInputSchema = {
  pageId: z.string().uuid().describe('The watched page whose preference to change.'),
  siteId: siteIdArg('Which site the page belongs to.', 'Omit on a single-site instance.'),
  notifyMode: z
    .enum(['immediate', 'digest'])
    .optional()
    .describe('How to be told about changes: one mail per change, or batched into a digest.'),
  notifyOnEdited: z.boolean().optional().describe('Hear about edits to the page.'),
  notifyOnMoved: z.boolean().optional().describe('Hear about the page being moved/renamed.'),
  notifyOnDeleted: z.boolean().optional().describe('Hear about the page being deleted.')
}

export interface SetPageWatchPreferenceArgs {
  pageId: string
  siteId?: string
  notifyMode?: 'immediate' | 'digest'
  notifyOnEdited?: boolean
  notifyOnMoved?: boolean
  notifyOnDeleted?: boolean
}

/**
 * Change the delivery preference on an existing watch, gated exactly like `PATCH
 * /_api/sites/:siteId/pages/:pageId/watch` (`api/watching.ts`): logged in, and nothing else -- same
 * reasoning as `watch_page`/`unwatch_page`. `siteId` is resolved purely for the key's own site-pin
 * enforcement; `models/pageWatching.ts#setPreference()` itself takes no `siteId`.
 *
 * Only the fields the caller actually passed are forwarded to `setPreference()` -- an omitted field
 * must stay a genuinely ABSENT key, not a key set to `undefined`. `setPreference()` decides whether
 * there is anything to update at all by `Object.keys(preference).length`, so passing all four keys
 * with `undefined` values (easy to do by naively spreading a fully-typed args object) would look like
 * four real changes and fall into its update path instead of its "nothing asked, just report whether
 * still watching" one.
 *
 * There is nothing to set a preference ON for a page the caller is not watching -- mirroring the REST
 * route, this throws rather than creating a watch as a side effect; call `watch_page` first.
 */
export async function handleSetPageWatchPreference(
  ctx: McpAuthContext,
  args: SetPageWatchPreferenceArgs
): Promise<CallToolResult> {
  resolveRequestedSite(ctx, args.siteId)
  if (!ctx.userId) {
    throw new McpToolError(
      'Setting a watch preference requires a personal access token -- watching belongs to an account, and an admin-issued key has none to watch as.'
    )
  }

  const preference: WatchNotifyPreference = {}
  if (args.notifyMode !== undefined) {
    preference.notifyMode = args.notifyMode
  }
  if (args.notifyOnEdited !== undefined) {
    preference.notifyOnEdited = args.notifyOnEdited
  }
  if (args.notifyOnMoved !== undefined) {
    preference.notifyOnMoved = args.notifyOnMoved
  }
  if (args.notifyOnDeleted !== undefined) {
    preference.notifyOnDeleted = args.notifyOnDeleted
  }

  const existed = await WIKI.models.pageWatching.setPreference({
    pageId: args.pageId,
    userId: ctx.userId,
    ...preference
  })
  if (!existed) {
    throw new McpToolError('You are not watching this page.')
  }
  const resolved = await WIKI.models.pageWatching.getPreference(args.pageId, ctx.userId)

  return toResult({ pageId: args.pageId, preference: resolved })
}

export function registerSetPageWatchPreferenceTool(
  server: McpServer,
  getCtx: McpAuthContextGetter
): void {
  server.registerTool(
    'set_page_watch_preference',
    {
      description:
        'Change how the caller hears about changes to a page they are already watching. Fields left out of the call are left as they were. Requires a personal access token. Refused (there is nothing to set a preference ON) if the caller is not already watching the page -- call `watch_page` first.',
      inputSchema: setPageWatchPreferenceInputSchema
    },
    (args) => handleSetPageWatchPreference(getCtx(), args)
  )
}
