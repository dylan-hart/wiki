import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  actorFor,
  maySeeEverything,
  pageActorFor,
  type McpAuthContext,
  type McpAuthContextGetter
} from '../auth.ts'
import { resolveRequestedSite } from '../site.ts'
import { siteIdArg, toResult } from './shared.ts'

const MAX_LIMIT = 50
const DEFAULT_LIMIT = 20

const searchPagesInputSchema = {
  query: z.string().min(1).describe('Full-text search terms.'),
  siteId: siteIdArg('Which site to search.'),
  locale: z.string().optional().describe('Restrict to one locale. Every locale when omitted.'),
  tags: z.array(z.string()).optional().describe('Only pages carrying every one of these tags.'),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional()
}

export interface SearchPagesArgs {
  query: string
  siteId?: string
  locale?: string
  tags?: string[]
  limit?: number
}

/**
 * Full-text search over a site's pages, filtered to what the configured key may actually read — same
 * engine, same `read:pages` filtering and password-excerpt hiding as `/_api/sites/:siteId/pages/search`
 * (`api/pages.ts`), just reached in-process instead of over HTTP. See `mcp/auth.ts`'s `McpAuthContext`
 * doc comment for what "may actually read" resolves to — the caller's own real group membership.
 *
 * `publicOnly` is derived from `pageActorFor(ctx)` exactly as the REST route derives it from
 * `actorFrom(req)`, so an admin-issued key (no `ctx.userId`) does not see a non-`draft` unpublished
 * page in results it would not see over REST.
 */
export async function handleSearchPages(
  ctx: McpAuthContext,
  args: SearchPagesArgs
): Promise<CallToolResult> {
  const site = resolveRequestedSite(ctx, args.siteId)
  const actor = actorFor(ctx)
  const seesEverything = maySeeEverything(actor, site.id)

  const result = await WIKI.models.search.query({
    siteId: site.id,
    query: args.query,
    locales: args.locale ? [args.locale] : undefined,
    tags: args.tags,
    limit: args.limit ?? DEFAULT_LIMIT,
    // -> Mirrors `actorFrom(req)` on `POST /_api/sites/:siteId/pages/search`: no attributable user
    //    behind the key means an anonymous searcher, restricted to published pages, on both
    //    transports alike.
    publicOnly: !pageActorFor(ctx),
    // -> So that a page the key could not open never reaches the caller
    actor,
    // -> An unpublished page is only of interest to someone who could have written it
    includeDrafts: seesEverything,
    // -> A protected page's excerpt is for whoever holds the password; the page itself still lists
    hideProtectedContent: !seesEverything
  })

  return toResult(result)
}

export function registerSearchPagesTool(server: McpServer, getCtx: McpAuthContextGetter): void {
  server.registerTool(
    'search_pages',
    {
      description:
        "Full-text search over a wiki site's pages. Returns matching pages with a highlighted excerpt, restricted to what the configured key may read.",
      inputSchema: searchPagesInputSchema
    },
    (args) => handleSearchPages(getCtx(), args)
  )
}
