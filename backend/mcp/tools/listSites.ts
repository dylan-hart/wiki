import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { defaultLocale } from '../../helpers/localeRouting.ts'
import { actorFor, type McpAuthContext, type McpAuthContextGetter } from '../auth.ts'
import type { McpSite } from '../site.ts'
import { toResult } from './shared.ts'

export interface ListedSite {
  id: string
  hostname: string
  title: string
  defaultLocale: string
}

/**
 * Whether `ctx` may know this site exists at all. Mirrors the REST equivalent (`GET /_api/sites`,
 * `permissions: ['access:admin']` in `api/sites.ts`) plus a page-rule fallback so a personal access
 * token that can actually read the site's pages — but holds no global permission — still discovers
 * it, the same way `read:pages` decides visibility everywhere else in `mcp/`. `manage:sites` is
 * accepted alongside `access:admin` since it also implies full site visibility through `/_api/`.
 */
function maySeeSite(ctx: McpAuthContext, site: McpSite): boolean {
  if (ctx.permissions.includes('access:admin') || ctx.permissions.includes('manage:sites')) {
    return true
  }
  return WIKI.models.groups.checkAccess(actorFor(ctx), 'read:pages', {
    path: '',
    locale: defaultLocale(site.id),
    siteId: site.id,
    classification: null
  })
}

/**
 * Every enabled site the configured key may reach — the whole instance for an unscoped key with
 * `access:admin`/`manage:sites`, just the sites its groups can actually read pages on otherwise, and
 * never more than the one site a site-pinned key is limited to. What `search_pages`/`get_page`/
 * `list_navigation`'s `siteId` argument expects, the same discovery role `list_projects` plays in
 * `openproject-mcp` — and, like that REST route, no longer a way for any valid token to enumerate
 * every site's hostname and title regardless of what it may actually reach.
 */
export function handleListSites(ctx: McpAuthContext): CallToolResult {
  const sites = Object.values(WIKI.sites as Record<string, McpSite>).filter(
    (site) => site.isEnabled && (!ctx.siteId || site.id === ctx.siteId) && maySeeSite(ctx, site)
  )
  const listed: ListedSite[] = sites.map((site) => ({
    id: site.id,
    hostname: site.hostname,
    title: site.config?.title ?? '',
    defaultLocale: defaultLocale(site.id)
  }))
  return toResult(listed)
}

export function registerListSitesTool(server: McpServer, getCtx: McpAuthContextGetter): void {
  server.registerTool(
    'list_sites',
    {
      description:
        'List the wiki sites this server can reach, with their id, hostname and default locale. Use the id as `siteId` on the other tools.',
      inputSchema: {}
    },
    () => handleListSites(getCtx())
  )
}
