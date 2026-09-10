import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
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
import { registerSideloadIconsTool } from './sideloadIcons.ts'

/**
 * The whole MCP tool surface: read (search, read a page, browse the page tree, list assets, list who
 * watches a page, and the site-discovery helper the others lean on), an actor-authed read
 * (`list_watched_pages` — the caller's own watch list), write (create/update a page, upload an asset,
 * rename an asset, delete an asset), page-watch management (watch/unwatch a page, change a watch's
 * delivery preference), and the diagram renderer (site-independent — it draws from posted source, not
 * from any page). Every tool is registered regardless of what `getCtx()` grants —
 * `create_page`/`update_page`/`upload_asset`/`list_watched_pages` refuse at call time for anything but
 * a personal access token (`pageActorFor()`/`ctx.userId` in `mcp/auth.ts`), `delete_asset` refuses at
 * call time for anything lacking `manage:assets` on the asset's folder, the same way the read tools
 * refuse per page rather than being hidden from a caller who cannot use them. `rename_asset` is the
 * one write tool with no such restriction — see its own doc comment. `watch_page`/`unwatch_page`/
 * `set_page_watch_preference` refuse at call time for anything but a personal access token too, but
 * check `ctx.userId` directly rather than `pageActorFor()` — watch state is an account preference, not
 * a page-rule-gated write (see `watchPage.ts`'s own doc comment). `sideload_icons` is the one
 * system-administration tool here: a hard `manage:system` gate, no lesser-privilege path, wrapping
 * the same `WIKI.models.icons.sideloadFromDataPath()` the `POST /_api/icons/sideload` route calls.
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
  registerSideloadIconsTool(server, getCtx)
}
