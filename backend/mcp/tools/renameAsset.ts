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

const renameAssetInputSchema = {
  assetId: z.string().uuid().describe('The asset to rename. See `list_assets` for the id.'),
  siteId: siteIdArg('Which site the asset belongs to.', 'Omit on a single-site instance.'),
  fileName: z
    .string()
    .min(3)
    .max(255)
    .describe(
      'The new file name, extension included -- the extension is part of the name, and changing it changes the type the file is served as. Sanitized, so the stored name may differ from the one sent.'
    )
}

export interface RenameAssetArgs {
  assetId: string
  siteId?: string
  fileName: string
}

/**
 * Rename an asset, gated exactly like `PATCH /_api/sites/:siteId/assets/:assetId`
 * (`api/assets.ts`): `manage:assets` on the folder the asset sits in — checked against the folder the
 * asset is in TODAY, mirroring how `helpers/pageAccess.ts#mayOnAsset` judges the REST route (asset
 * permissions come from a group's page RULES, addressed by path, not from `config.permissions` — see
 * that helper's own doc comment). `mayOnAsset` itself takes a Fastify `req` rather than an
 * `McpAuthContext`, so the check is re-expressed here via `checkAccess()` directly, the same
 * REST-vs-MCP divergence `update_page` already has from `helpers/pageAccess.ts#requireReadablePage`.
 *
 * No personal-access-token restriction, unlike `create_page`/`update_page`: an asset carries no
 * author to attribute a rename to — `models/assets.ts#renameAsset()` takes no actor argument at all —
 * so an admin-issued key works here exactly as it does for the REST route.
 */
export async function handleRenameAsset(
  ctx: McpAuthContext,
  args: RenameAssetArgs
): Promise<CallToolResult> {
  const site = resolveRequestedSite(ctx, args.siteId)

  const existing = await WIKI.models.assets.getAsset(site.id, args.assetId)
  if (!existing) {
    throw new McpToolError('This asset does not exist.')
  }
  const path = existing.folderPath
    ? `${existing.folderPath}/${existing.fileName}`
    : existing.fileName
  if (
    !WIKI.models.groups.checkAccess(actorFor(ctx), 'manage:assets', {
      path,
      siteId: site.id,
      locale: existing.locale,
      // -> An asset carries no classification of its own — same treatment as `mayOnAsset()`'s own
      //    REST check.
      classification: null
    })
  ) {
    throw new McpToolError('You are not allowed to rename this file.')
  }

  let asset
  try {
    asset = await WIKI.models.assets.renameAsset(site.id, args.assetId, args.fileName)
  } catch (err: any) {
    throw new McpToolError(err.message)
  }
  if (!asset) {
    throw new McpToolError('This asset does not exist.')
  }

  // -> #1118-style instrumentation, mirroring `update_page`'s own: instance-wide visibility that an
  //    agent renamed this file, separate from any per-asset history (assets keep none today).
  await WIKI.models.auditLog.record({
    event: 'mcp.writeToolCalled',
    actor: auditActorFor(ctx),
    targetType: 'asset',
    targetId: asset.id,
    targetLabel: asset.folderPath ? `${asset.folderPath}/${asset.fileName}` : asset.fileName,
    detail: { tool: 'rename_asset' },
    siteId: site.id
  })

  return toResult({
    id: asset.id,
    fileName: asset.fileName,
    folderPath: asset.folderPath,
    mimeType: asset.mimeType,
    kind: asset.kind,
    updatedAt: asset.updatedAt
  })
}

export function registerRenameAssetTool(server: McpServer, getCtx: McpAuthContextGetter): void {
  server.registerTool(
    'rename_asset',
    {
      description:
        'Rename an existing asset (file). The extension is part of the name; changing it changes the type the file is served as. Requires `manage:assets` on the folder it sits in.',
      inputSchema: renameAssetInputSchema
    },
    (args) => handleRenameAsset(getCtx(), args)
  )
}
