import { z } from 'zod'
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server'
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
 * `api/assets.ts` has no listing route: asset listing is `GET /sites/:siteId/tree` filtered to
 * `types: ['asset']`, so this calls that same `tree.getTree()` and layers on the `read:assets` filter
 * `helpers/pageAccess.ts#visibleTreeItems` applies REST-side.
 *
 * No `browse` feature gate — that setting governs only the reader-facing sidebar, and neither the
 * general tree listing nor `api/assets.ts` checks it. `getTree()` does not 404 on an unknown folder
 * path, so a nonexistent folder answers an empty list rather than an error.
 */
export async function handleListAssets(
  ctx: McpAuthContext,
  args: ListAssetsArgs
): Promise<CallToolResult> {
  const site = resolveRequestedSite(ctx, args.siteId)
  const locale = args.locale ?? defaultLocale(site.id)

  const items = await CARDINAL.models.tree.getTree({
    siteId: site.id,
    parentPath: args.path,
    locale,
    types: ['asset']
  })

  const actor = actorFor(ctx)
  const assets: ListedAsset[] = items
    .filter((item) =>
      CARDINAL.models.groups.checkAccess(actor, 'read:assets', {
        path: item.folderPath ? `${item.folderPath}/${item.fileName}` : item.fileName,
        siteId: site.id,
        locale,
        // -> An asset carries no classification of its own, as in `helpers/pageAccess.ts#mayOnAsset`
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
