import type { McpServer } from '@modelcontextprotocol/server'
import type { McpAuthContextGetter } from '../auth.ts'
import { registerListSitesTool } from './listSites.ts'
import { registerSearchPagesTool } from './searchPages.ts'
import { registerGetPageTool } from './getPage.ts'
import { registerListNavigationTool } from './listNavigation.ts'
import { registerListAssetsTool } from './listAssets.ts'
import { registerListWatchedPagesTool } from './listWatchedPages.ts'
import { registerListPageWatchersTool } from './listPageWatchers.ts'
import { registerCreatePageTool } from './createPage.ts'
import { registerUpdatePageTool } from './updatePage.ts'
import { registerRenderDiagramTool } from './renderDiagram.ts'
import { registerUploadAssetTool } from './uploadAsset.ts'
import { registerRenameAssetTool } from './renameAsset.ts'
import { registerDeleteAssetTool } from './deleteAsset.ts'
import { registerWatchPageTool } from './watchPage.ts'
import { registerUnwatchPageTool } from './unwatchPage.ts'
import { registerSetPageWatchPreferenceTool } from './setPageWatchPreference.ts'
import { registerSideloadLocalesTool } from './sideloadLocales.ts'
import { registerSideloadIconsTool } from './sideloadIcons.ts'

/**
 * Every tool is registered whatever `getCtx()` grants: each refuses at call time instead of being
 * hidden, so a caller who cannot use one gets a reason rather than a missing tool.
 */
export function registerAllTools(server: McpServer, getCtx: McpAuthContextGetter): void {
  registerListSitesTool(server, getCtx)
  registerSearchPagesTool(server, getCtx)
  registerGetPageTool(server, getCtx)
  registerListNavigationTool(server, getCtx)
  registerListAssetsTool(server, getCtx)
  registerListWatchedPagesTool(server, getCtx)
  registerListPageWatchersTool(server, getCtx)
  registerCreatePageTool(server, getCtx)
  registerUpdatePageTool(server, getCtx)
  registerRenderDiagramTool(server, getCtx)
  registerUploadAssetTool(server, getCtx)
  registerRenameAssetTool(server, getCtx)
  registerDeleteAssetTool(server, getCtx)
  registerWatchPageTool(server, getCtx)
  registerUnwatchPageTool(server, getCtx)
  registerSetPageWatchPreferenceTool(server, getCtx)
  registerSideloadLocalesTool(server, getCtx)
  registerSideloadIconsTool(server, getCtx)
}
