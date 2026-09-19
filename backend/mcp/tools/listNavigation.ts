import { z } from 'zod'
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server'
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
 * Mirrors `GET /_api/sites/:siteId/tree/browse` (`api/tree.ts`): the same `tree.browse()` call, the
 * same per-item `read:pages` filter layered on top, the same `browse` feature gate.
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
  const level = await CARDINAL.models.tree.browse({
    siteId: site.id,
    path: args.path,
    locale,
    // -> `tree.browse()`'s own filter is publish-state only; the per-page grant is the
    //    `checkAccess()` filter below, as on the HTTP route
    publicOnly: false
  })
  if (!level) {
    throw new McpToolError('This folder does not exist.')
  }

  const actor = actorFor(ctx)
  return toResult({
    ...level,
    items: level.items.filter((item) =>
      CARDINAL.models.groups.checkAccess(actor, 'read:pages', {
        path: item.path,
        siteId: site.id,
        locale,
        // -> `tree.browse()` joins `pages.classification` in where a page sits at this path; a
        //    folder-only entry carries none, so no CLASSIFICATION rule matches it
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
