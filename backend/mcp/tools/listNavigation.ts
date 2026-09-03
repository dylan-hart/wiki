import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { actorFor, McpToolError, type McpAuthContext, type McpAuthContextGetter } from '../auth.ts'
import { defaultLocale } from '../../helpers/localeRouting.ts'
import { resolveRequestedSite } from '../site.ts'
import { localeArg, siteIdArg, toResult } from './shared.ts'

const listNavigationInputSchema = {
  siteId: siteIdArg('Which site to browse.'),
  path: z
    .string()
    .optional()
    .describe('Slash-separated path of the folder to list. The site root when omitted.'),
  locale: localeArg
}

export interface ListNavigationArgs {
  siteId?: string
  path?: string
  locale?: string
}

/**
 * List one folder of a site's page tree — the pages the configured key may open and the folders worth
 * descending into — mirroring `GET /_api/sites/:siteId/tree/browse` (`api/tree.ts`) exactly: the same
 * `tree.browse()` call, the same per-item `read:pages` filter layered on top of it. Requires the site's
 * `browse` feature to be on, same as the HTTP route.
 */
export async function handleListNavigation(
  ctx: McpAuthContext,
  args: ListNavigationArgs
): Promise<CallToolResult> {
  const site = resolveRequestedSite(ctx, args.siteId)
  if (!site.config?.features?.browse) {
    throw new McpToolError('Browsing is disabled on this site.')
  }

  const locale = args.locale ?? defaultLocale(site.id)
  const level = await WIKI.models.tree.browse({
    siteId: site.id,
    path: args.path,
    locale,
    // -> `tree.browse()`'s own filter is publish-state only (see `pageIsVisible()`); the real
    //    per-page grant is the `checkAccess()` filter below, same division of labor as the HTTP route
    publicOnly: false
  })
  if (!level) {
    throw new McpToolError('This folder does not exist.')
  }

  const actor = actorFor(ctx)
  return toResult({
    ...level,
    items: level.items.filter((item) =>
      WIKI.models.groups.checkAccess(actor, 'read:pages', {
        path: item.path,
        siteId: site.id,
        locale,
        // -> `tree.browse()` (OpenProject #1128) joins `pages.classification` in for a page at this
        //    path; a folder-only entry carries none, same "no CLASSIFICATION rule matches" null it
        //    always had.
        classification: item.classification
      })
    )
  })
}

export function registerListNavigationTool(server: McpServer, getCtx: McpAuthContextGetter): void {
  server.registerTool(
    'list_navigation',
    {
      description:
        "List one folder of a wiki site's page tree: the pages and sub-folders a reader may open there, restricted to what the configured key may read.",
      inputSchema: listNavigationInputSchema
    },
    (args) => handleListNavigation(getCtx(), args)
  )
}
