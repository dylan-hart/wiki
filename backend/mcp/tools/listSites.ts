import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { McpAuthContext, McpAuthContextGetter } from '../auth.ts'
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
 * Every enabled site the configured key may reach — the whole instance for an unscoped key, or just
 * the one site a site-pinned key is limited to. What `search_pages`/`get_page`/`list_navigation`'s
 * `siteId` argument expects, the same discovery role `list_projects` plays in `openproject-mcp`.
 */
export function handleListSites(ctx: McpAuthContext): CallToolResult {
  const sites = Object.values(WIKI.sites as Record<string, McpSite>).filter(
    (site) => site.isEnabled && (!ctx.siteId || site.id === ctx.siteId)
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
