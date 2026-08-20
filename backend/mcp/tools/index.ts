import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpAuthContext } from '../auth.ts'
import { registerListSitesTool } from './listSites.ts'
import { registerSearchPagesTool } from './searchPages.ts'
import { registerGetPageTool } from './getPage.ts'
import { registerListNavigationTool } from './listNavigation.ts'

/**
 * The whole read-only tool surface, task #789's first pass — search, read a page, browse the tree, and
 * the site-discovery helper the other three lean on. Write tools (create/update a page) are deliberately
 * not here yet; see `docs/variances.md` for why.
 */
export function registerAllTools(server: McpServer, ctx: McpAuthContext): void {
  registerListSitesTool(server, ctx)
  registerSearchPagesTool(server, ctx)
  registerGetPageTool(server, ctx)
  registerListNavigationTool(server, ctx)
}
