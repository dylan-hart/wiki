import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpAuthContext } from '../auth.ts'
import { registerListSitesTool } from './listSites.ts'
import { registerSearchPagesTool } from './searchPages.ts'
import { registerGetPageTool } from './getPage.ts'
import { registerListNavigationTool } from './listNavigation.ts'
import { registerCreatePageTool } from './createPage.ts'
import { registerUpdatePageTool } from './updatePage.ts'

/**
 * The whole MCP tool surface: read (search, read a page, browse the tree, and the site-discovery
 * helper the others lean on) plus write (create/update a page). Every tool is registered regardless of
 * what `ctx` grants — `create_page`/`update_page` refuse at call time for anything but a personal
 * access token (`pageActorFor()` in `mcp/auth.ts`), the same way the read tools refuse per page rather
 * than being hidden from a caller who cannot use them.
 */
export function registerAllTools(server: McpServer, ctx: McpAuthContext): void {
  registerListSitesTool(server, ctx)
  registerSearchPagesTool(server, ctx)
  registerGetPageTool(server, ctx)
  registerListNavigationTool(server, ctx)
  registerCreatePageTool(server, ctx)
  registerUpdatePageTool(server, ctx)
}
