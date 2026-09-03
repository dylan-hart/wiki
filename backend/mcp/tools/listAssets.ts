import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { defaultLocale } from '../../helpers/localeRouting.ts'
import { actorFor, type McpAuthContext, type McpAuthContextGetter } from '../auth.ts'
import { resolveRequestedSite } from '../site.ts'
import { localeArg, siteIdArg, toResult } from './shared.ts'

const listAssetsInputSchema = {
  siteId: siteIdArg('Which site to list assets on.'),
  path: z
    .string()
    .optional()
    .describe('Slash-separated path of the folder to list assets in. The site root when omitted.'),
  locale: localeArg
}

export interface ListAssetsArgs {
  siteId?: string
  path?: string
  locale?: string
}

export interface ListedAsset {
  id: string
  fileName: string
  folderPath: string
  title: string
  fileExt?: string
  mimeType?: string
  fileSize?: number
  createdAt: Date
  updatedAt: Date
}

/**
 * List the assets (uploaded files) in one folder of a site's tree, restricted to what the configured
 * key may read.
 *
 * `backend/api/assets.ts` (the REST route this feature otherwise wraps — upload/get/download/rename/
 * delete) has no listing route of its own: asset listing lives in `GET /sites/:siteId/tree`
 * (`api/tree.ts`), one call filtered to `types: ['asset']`, which is also what the file manager itself
 * calls. This tool calls that same model method, `WIKI.models.tree.getTree()`, directly — the same
 * "call the model method the REST route calls" pattern `list_navigation` already uses for
 * `tree.browse()` — then applies the per-item permission filter `helpers/pageAccess.ts#mayOnAsset`/
 * `visibleTreeItems` apply on the REST side: `read:assets`, judged on the asset's own path, with a
 * `classification` of `null` since an asset (unlike a page) carries none.
 *
 * No `browse` feature gate: that setting only governs the reader-facing sidebar
 * (`GET /sites/:siteId/tree/browse`) — the general tree listing this mirrors, and every route in
 * `api/assets.ts`, do not check it either.
 *
 * `getTree()` does not 404 on an unknown folder path — an unmatched `parentPath` just yields no rows —
 * so an empty or nonexistent folder both answer an empty list here too, matching
 * `GET /sites/:siteId/tree`'s own behavior (its response schema has no 404).
 */
export async function handleListAssets(
  ctx: McpAuthContext,
  args: ListAssetsArgs
): Promise<CallToolResult> {
  const site = resolveRequestedSite(ctx, args.siteId)
  const locale = args.locale ?? defaultLocale(site.id)

  const items = await WIKI.models.tree.getTree({
    siteId: site.id,
    parentPath: args.path,
    locale,
    types: ['asset']
  })

  const actor = actorFor(ctx)
  const assets: ListedAsset[] = items
    .filter((item) =>
      WIKI.models.groups.checkAccess(actor, 'read:assets', {
        path: item.folderPath ? `${item.folderPath}/${item.fileName}` : item.fileName,
        siteId: site.id,
        locale,
        // -> An asset carries no classification of its own — same as `mayOnAsset()`/
        //    `visibleTreeItems()` in `helpers/pageAccess.ts`.
        classification: null
      })
    )
    .map((item) => ({
      id: item.id,
      fileName: item.fileName,
      folderPath: item.folderPath,
      title: item.title,
      fileExt: item.fileExt,
      mimeType: item.mimeType,
      fileSize: item.fileSize,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    }))

  return toResult(assets)
}

export function registerListAssetsTool(server: McpServer, getCtx: McpAuthContextGetter): void {
  server.registerTool(
    'list_assets',
    {
      description:
        "List the assets (uploaded files) in one folder of a wiki site's tree, restricted to what the configured key may read.",
      inputSchema: listAssetsInputSchema
    },
    (args) => handleListAssets(getCtx(), args)
  )
}
