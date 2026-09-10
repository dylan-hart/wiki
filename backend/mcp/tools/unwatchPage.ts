import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { McpToolError, type McpAuthContext, type McpAuthContextGetter } from '../auth.ts'
import { resolveRequestedSite } from '../site.ts'
import { siteIdArg, toResult } from './shared.ts'

const unwatchPageInputSchema = {
  pageId: z.string().uuid().describe('The page to stop watching.'),
  siteId: siteIdArg('Which site the page belongs to.', 'Omit on a single-site instance.')
}

export interface UnwatchPageArgs {
  pageId: string
  siteId?: string
}

/**
 * Stop watching a page, gated exactly like `DELETE /_api/sites/:siteId/pages/:pageId/watch`
 * (`api/watching.ts`): logged in, and nothing else -- checked on `ctx.userId` directly, same reasoning
 * as `watch_page`. `siteId` is resolved purely for the key's own site-pin enforcement
 * (`resolveRequestedSite()`); `models/pageWatching.ts#unwatch()` itself takes no `siteId` at all.
 *
 * The page is deliberately NOT loaded first, mirroring the REST route's own comment: unwatching has
 * to keep working for a page that has since become unreadable (or been deleted -- though the row would
 * already be gone with it via the cascade), or the row would be stuck there with nothing able to
 * remove it. There is nothing to protect either way -- this only ever deletes the caller's own row.
 * Idempotent, like the model method: unwatching a page not being watched still answers success.
 */
export async function handleUnwatchPage(
  ctx: McpAuthContext,
  args: UnwatchPageArgs
): Promise<CallToolResult> {
  resolveRequestedSite(ctx, args.siteId)
  if (!ctx.userId) {
    throw new McpToolError(
      'Unwatching a page requires a personal access token -- watching belongs to an account, and an admin-issued key has none to watch as.'
    )
  }

  await WIKI.models.pageWatching.unwatch({ pageId: args.pageId, userId: ctx.userId })

  return toResult({ pageId: args.pageId, isWatching: false })
}

export function registerUnwatchPageTool(server: McpServer, getCtx: McpAuthContextGetter): void {
  server.registerTool(
    'unwatch_page',
    {
      description:
        'Stop watching a page. Requires a personal access token. Idempotent -- unwatching a page that was not being watched still succeeds.',
      inputSchema: unwatchPageInputSchema
    },
    (args) => handleUnwatchPage(getCtx(), args)
  )
}
