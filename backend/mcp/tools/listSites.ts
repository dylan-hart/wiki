import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { actorFor, type McpAuthContext, type McpAuthContextGetter } from '../auth.ts'
import { defaultLocale, type McpSite } from '../site.ts'

function toResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

export interface ListedSite {
  id: string
  hostname: string
  title: string
  defaultLocale: string
}

/**
 * Whether the calling identity may see this site at all — mirrors `GET /_api/sites`
 * (`api/sites.ts`)'s `access:admin` gate, widened to also admit `manage:sites` (the other global
 * permission that names sites outright), and further widened to a caller who can genuinely read
 * SOMETHING on the site: a page-blind `read:pages` probe against the site's root at its default
 * locale, the same shape `checkAccess()` expects for a not-yet-existing page (OpenProject #1205
 * §5). Without this, a token whose groups grant nothing enumerated every enabled site's hostname
 * and title on a multi-tenant instance.
 */
function maySeeSite(ctx: McpAuthContext, site: McpSite): boolean {
  if (ctx.permissions.includes('access:admin') || ctx.permissions.includes('manage:sites')) {
    return true
  }
  return WIKI.models.groups.checkAccess(actorFor(ctx), 'read:pages', {
    path: '',
    siteId: site.id,
    locale: defaultLocale(site),
    classification: null
  })
}

/**
 * Every enabled site the configured key may reach — the whole instance for an unscoped key, or just
 * the one site a site-pinned key is limited to, further narrowed to sites the calling identity can
 * actually read something on (see `maySeeSite()`). What `search_pages`/`get_page`/`list_navigation`'s
 * `siteId` argument expects, the same discovery role `list_projects` plays in `openproject-mcp`.
 */
export function handleListSites(ctx: McpAuthContext): CallToolResult {
  const sites = Object.values(WIKI.sites as Record<string, McpSite>).filter(
    (site) => site.isEnabled && (!ctx.siteId || site.id === ctx.siteId) && maySeeSite(ctx, site)
  )
  const listed: ListedSite[] = sites.map((site) => ({
    id: site.id,
    hostname: site.hostname,
    title: site.config?.title ?? '',
    defaultLocale: defaultLocale(site)
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
