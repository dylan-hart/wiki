import { z } from 'zod'
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server'
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
 * Gated like `DELETE /_api/sites/:siteId/assets/:assetId` (`api/assets.ts`): `manage:assets` on the
 * folder the file sits in. Unlike `create_page`/`update_page` no personal access token is required:
 * the REST route has no logged-in guard either, and an admin-issued key's groups can hold
 * `manage:assets` too.
 */
export async function handleDeleteAsset(
  ctx: McpAuthContext,
  args: DeleteAssetArgs
): Promise<CallToolResult> {
  const site = resolveRequestedSite(ctx, args.siteId)

  const doomed = await CARDINAL.models.assets.getAsset(site.id, args.assetId)
  if (!doomed) {
    throw new McpToolError('This asset does not exist.')
  }

  // -> Mirrors `helpers/pageAccess.ts#mayOnAsset()`, which needs a `FastifyRequest` an MCP tool call
  //    does not have.
  if (
    !CARDINAL.models.groups.checkAccess(actorFor(ctx), 'manage:assets', {
      path: doomed.folderPath ? `${doomed.folderPath}/${doomed.fileName}` : doomed.fileName,
      siteId: site.id,
      locale: doomed.locale,
      // -> An asset carries no classification of its own.
      classification: null
    })
  ) {
    throw new McpToolError('You are not allowed to delete this file.')
  }

  // -> False when the asset was removed concurrently since the `getAsset()` lookup; the REST route
  //    answers 404 for that too, not a silently-successful delete.
  if (
    !(await CARDINAL.models.assets.deleteAsset(site.id, args.assetId, { authorId: ctx.userId }))
  ) {
    throw new McpToolError('This asset does not exist.')
  }

  await CARDINAL.models.auditLog.record({
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
