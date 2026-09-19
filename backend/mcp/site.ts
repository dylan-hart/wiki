import { assertSiteInScope, McpToolError } from './auth.ts'
import type { McpAuthContext } from './auth.ts'

/**
 * Not derived from `db/schema.ts`'s `SiteRow`: that type's `config` is `Record<string, any>`, and
 * this keeps a narrow projection of the keys `mcp/` reads.
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
 * The check `helpers/siteResolution.ts#guardSiteEnabled` applies to `:siteId`-scoped `/_api` routes,
 * throwing since there is no `FastifyReply` here to write to.
 */
export function resolveSite(siteId: string): McpSite {
  const site = CARDINAL.sites[siteId] as McpSite | undefined
  if (!site) {
    throw new McpToolError('This site does not exist.')
  }
  if (!site.isEnabled) {
    throw new McpToolError('This site is currently disabled.')
  }
  return site
}

/**
 * For a tool call naming no site: the key's pinned site, else the sole enabled site — the common
 * single-site wiki. `null` on a multi-site instance, where an unscoped key must pass `siteId`.
 */
export function resolveDefaultSiteId(ctx: McpAuthContext): string | null {
  if (ctx.siteId) {
    return ctx.siteId
  }
  const enabled = Object.values(CARDINAL.sites as Record<string, McpSite>).filter(
    (s) => s.isEnabled
  )
  return enabled.length === 1 ? enabled[0].id : null
}

/**
 * Refuses rather than picking arbitrarily among several sites. Applies `assertSiteInScope()`, so a
 * tool resolving its site through here needs no site-pin check of its own.
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
