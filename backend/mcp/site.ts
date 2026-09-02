import { assertSiteInScope, McpToolError } from './auth.ts'
import type { McpAuthContext } from './auth.ts'

/**
 * A site as `WIKI.sites` caches it. Untyped upstream (`types/global.d.ts` has `sites: Record<string,
 * any>` with a standing TODO to tighten it against the Drizzle row type) — narrowed to the fields
 * `mcp/` actually reads, the same way callers elsewhere in `backend/` read off `WIKI.sites[id]`
 * without a shared type for the whole row.
 */
export interface McpSite {
  id: string
  hostname: string
  isEnabled: boolean
  config: {
    title?: string
    locales?: { primary?: string }
    features?: { browse?: boolean }
  }
}

/**
 * Resolve a site by id, refusing one that does not exist or is disabled — the same
 * `helpers/common.ts`'s `guardSiteEnabled()` check `api/index.ts`'s shared `preHandler` applies to
 * every content/feature `:siteId`-scoped `/_api` route (OpenProject task 1593; `api/sites.ts`'s own
 * site-ADMINISTRATION routes are deliberately excluded there, see its comment), adapted to throw since
 * there is no `FastifyReply` here to write to, and to answer "does not exist" rather than leaving an
 * unknown id as "not my problem" the way that preHandler does.
 */
export function resolveSite(siteId: string): McpSite {
  const site = WIKI.sites[siteId] as McpSite | undefined
  if (!site) {
    throw new McpToolError('This site does not exist.')
  }
  if (!site.isEnabled) {
    throw new McpToolError('This site is currently disabled.')
  }
  return site
}

/**
 * The site id to use when a tool call does not name one: the configured key's own pinned site, if it
 * has one, else the sole enabled site when there is exactly one — the common single-site wiki. A
 * multi-site instance with an unscoped key must always pass `siteId` explicitly; `list_sites` is how
 * it discovers what to pass, the same role `list_projects` plays in `openproject-mcp`.
 */
export function resolveDefaultSiteId(ctx: McpAuthContext): string | null {
  if (ctx.siteId) {
    return ctx.siteId
  }
  const enabled = Object.values(WIKI.sites as Record<string, McpSite>).filter((s) => s.isEnabled)
  return enabled.length === 1 ? enabled[0].id : null
}

/**
 * Resolve the site a tool call should act on: the explicit `siteId` argument if given, else
 * `resolveDefaultSiteId()`'s guess — refusing outright when neither settles on one, rather than
 * silently picking an arbitrary site out of several. Also enforces `assertSiteInScope()`, so every
 * tool that resolves its site through here gets the key's site-pinning check for free.
 */
export function resolveRequestedSite(ctx: McpAuthContext, siteId?: string): McpSite {
  const resolvedId = siteId ?? resolveDefaultSiteId(ctx) ?? undefined
  if (!resolvedId) {
    throw new McpToolError(
      'This instance has more than one site; pass `siteId` (see the `list_sites` tool).'
    )
  }
  assertSiteInScope(ctx, resolvedId)
  return resolveSite(resolvedId)
}
