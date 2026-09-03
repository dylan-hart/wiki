import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  actorFor,
  auditActorFor,
  McpToolError,
  type McpAuthContext,
  type McpAuthContextGetter
} from '../auth.ts'
import { resolveRequestedSite } from '../site.ts'
import { siteIdArg, toResult } from './shared.ts'

const deleteAssetInputSchema = {
  assetId: z.string().uuid().describe('The asset to delete. See `list_assets` for the id.'),
  siteId: siteIdArg('Which site the asset belongs to.')
}

export interface DeleteAssetArgs {
  assetId: string
  siteId?: string
}

/**
 * Delete an asset, gated exactly like `DELETE /_api/sites/:siteId/assets/:assetId`
 * (`api/assets.ts`): `manage:assets` on the folder the file sits in. Checked against the asset as it
 * stands, so a rule scoped to one branch is honored the same way it is for the REST route.
 *
 * Unlike `create_page`/`update_page`, this does not require a personal access token
 * (`pageActorFor()`): the REST route itself has no "must be logged in" guard ahead of its permission
 * check — `manage:assets` is a page-rule permission an admin-issued key's groups can hold just as
 * well as a personal token's — so only `actorFor()` is needed here.
 */
export async function handleDeleteAsset(
  ctx: McpAuthContext,
  args: DeleteAssetArgs
): Promise<CallToolResult> {
  const site = resolveRequestedSite(ctx, args.siteId)

  const doomed = await WIKI.models.assets.getAsset(site.id, args.assetId)
  if (!doomed) {
    throw new McpToolError('This asset does not exist.')
  }

  // -> Mirrors `helpers/pageAccess.ts#mayOnAsset()`'s path construction: that helper takes a
  //    `FastifyRequest` to resolve its actor from, which an MCP tool call has no equivalent of, so
  //    the same `folderPath`/`fileName` -> path shape is rebuilt here against `actorFor(ctx)` instead.
  if (
    !WIKI.models.groups.checkAccess(actorFor(ctx), 'manage:assets', {
      path: doomed.folderPath ? `${doomed.folderPath}/${doomed.fileName}` : doomed.fileName,
      siteId: site.id,
      locale: doomed.locale,
      // -> An asset carries no classification of its own -- same as `mayOnAsset()`.
      classification: null
    })
  ) {
    throw new McpToolError('You are not allowed to delete this file.')
  }

  // -> Can still be false here: the asset existed at the `getAsset()` lookup above but was removed
  //    concurrently before this call landed. The REST route treats that the same as never having
  //    found it -- a 404, not a silently-successful delete -- so this does too.
  if (!(await WIKI.models.assets.deleteAsset(site.id, args.assetId))) {
    throw new McpToolError('This asset does not exist.')
  }

  // -> #1118: same reasoning as `updatePage.ts`'s own instrumentation -- instance-wide visibility
  //   that an agent deleted this, distinct from any per-page attribution.
  await WIKI.models.auditLog.record({
    event: 'mcp.writeToolCalled',
    actor: auditActorFor(ctx),
    targetType: 'asset',
    targetId: doomed.id,
    targetLabel: doomed.folderPath ? `${doomed.folderPath}/${doomed.fileName}` : doomed.fileName,
    detail: { tool: 'delete_asset' },
    siteId: site.id
  })

  return toResult({
    ok: true,
    id: doomed.id,
    fileName: doomed.fileName,
    folderPath: doomed.folderPath
  })
}

export function registerDeleteAssetTool(server: McpServer, getCtx: McpAuthContextGetter): void {
  server.registerTool(
    'delete_asset',
    {
      description:
        'Delete an asset (a file stored in the wiki). Requires `manage:assets` on the folder the file sits in. This cannot be undone.',
      inputSchema: deleteAssetInputSchema
    },
    (args) => handleDeleteAsset(getCtx(), args)
  )
}
