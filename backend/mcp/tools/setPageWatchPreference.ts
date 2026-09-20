import { z } from 'zod'
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server'
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
 * Gated like `PATCH /_api/sites/:siteId/pages/:pageId/watch` (`api/watching.ts`): logged in, and
 * nothing else. `siteId` is resolved purely to enforce the key's own site pin --
 * `models/pageWatching.ts#setPreference()` itself takes none.
 *
 * An omitted field must stay a genuinely ABSENT key rather than one set to `undefined`:
 * `setPreference()` decides whether there is anything to update by `Object.keys(preference).length`,
 * so spreading a fully-typed args object would read as four real changes.
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

  const existed = await CARDINAL.models.pageWatching.setPreference({
    pageId: args.pageId,
    userId: ctx.userId,
    ...preference
  })
  if (!existed) {
    throw new McpToolError('You are not watching this page.')
  }
  const resolved = await CARDINAL.models.pageWatching.getPreference(args.pageId, ctx.userId)

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
