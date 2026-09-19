import type { McpServer, CallToolResult } from '@modelcontextprotocol/server'
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
 * Mirrors `GET /_api/sites`'s `access:admin` gate, plus a page-rule fallback so a key that can
 * actually read the site's pages but holds no global permission still discovers it. `manage:sites`
 * counts too: it already implies full site visibility through `/_api/`.
 */
function maySeeSite(ctx: McpAuthContext, site: McpSite): boolean {
  if (ctx.permissions.includes('access:admin') || ctx.permissions.includes('manage:sites')) {
    return true
  }
  return CARDINAL.models.groups.checkAccess(actorFor(ctx), 'read:pages', {
    path: '',
    locale: defaultLocale(site.id),
    siteId: site.id,
    classification: null
  })
}

export function handleListSites(ctx: McpAuthContext): CallToolResult {
  const sites = Object.values(CARDINAL.sites as Record<string, McpSite>).filter(
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
