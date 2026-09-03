import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpAuthContextGetter } from '../auth.ts'
import { registerListSitesTool } from './listSites.ts'
import { registerSearchPagesTool } from './searchPages.ts'
import { registerGetPageTool } from './getPage.ts'
import { registerListNavigationTool } from './listNavigation.ts'
import { registerListAssetsTool } from './listAssets.ts'
import { registerCreatePageTool } from './createPage.ts'
import { registerUpdatePageTool } from './updatePage.ts'
import { registerRenderDiagramTool } from './renderDiagram.ts'
import { registerUploadAssetTool } from './uploadAsset.ts'
import { registerRenameAssetTool } from './renameAsset.ts'
import { registerDeleteAssetTool } from './deleteAsset.ts'

/**
 * The whole MCP tool surface: read (search, read a page, browse the page tree, list assets, and the
 * site-discovery helper the others lean on), write (create/update a page, upload an asset, rename an
 * asset, delete an asset), and the diagram renderer (site-independent — it draws from posted source,
 * not from any page). Every tool is registered regardless of what `getCtx()` grants —
 * `create_page`/`update_page`/`upload_asset` refuse at call time for anything but a personal access
 * token (`pageActorFor()`/`ctx.userId` in `mcp/auth.ts`), `delete_asset` refuses at call time for
 * anything lacking `manage:assets` on the asset's folder, the same way the read tools refuse per page
 * rather than being hidden from a caller who cannot use them. `rename_asset` is the one write tool
 * with no such restriction — see its own doc comment.
 *
 * `getCtx` rather than a plain `McpAuthContext`: see that type's doc comment in `mcp/auth.ts` for why a
 * long-lived HTTP session re-resolves it per request instead of fixing it at session-open time.
 */
export function registerAllTools(server: McpServer, getCtx: McpAuthContextGetter): void {
  registerListSitesTool(server, getCtx)
  registerSearchPagesTool(server, getCtx)
  registerGetPageTool(server, getCtx)
  registerListNavigationTool(server, getCtx)
  registerListAssetsTool(server, getCtx)
  registerCreatePageTool(server, getCtx)
  registerUpdatePageTool(server, getCtx)
  registerRenderDiagramTool(server, getCtx)
  registerUploadAssetTool(server, getCtx)
  registerRenameAssetTool(server, getCtx)
  registerDeleteAssetTool(server, getCtx)
}
