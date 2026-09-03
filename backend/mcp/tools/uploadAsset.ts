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
import { decodeTreePath, normalizePagePath } from '../../helpers/common.ts'
import { localeArg, siteIdArg, toResult } from './shared.ts'

const uploadAssetInputSchema = {
  fileName: z
    .string()
    .min(1)
    .max(255)
    .describe(
      'What to call the file. Sanitized on the way in, so the stored name in the response may differ from this.'
    ),
  content: z.string().min(1).describe('The file bytes, base64-encoded.'),
  mimeType: z
    .string()
    .optional()
    .describe(
      "The content type of the bytes in `content`. The stored type is derived from `fileName`'s extension when omitted or when it disagrees."
    ),
  siteId: siteIdArg('Which site to upload to.'),
  locale: localeArg,
  folderId: z
    .string()
    .uuid()
    .optional()
    .describe('The folder to upload into, by id. Wins over `parentPath` when both are given.'),
  parentPath: z
    .string()
    .max(2048)
    .optional()
    .describe(
      'Slash-separated path of the folder to upload into, created (along with any missing ancestor) if it does not exist yet. The site root when omitted.'
    )
}

export interface UploadAssetArgs {
  fileName: string
  content: string
  mimeType?: string
  siteId?: string
  locale?: string
  folderId?: string
  parentPath?: string
}

/**
 * Upload an asset, gated exactly like `POST /_api/sites/:siteId/assets` (`api/assets.ts`): a
 * logged-in user only — mirrored here as a personal access token, the only MCP identity with a real
 * user behind it (see `pageActorFor()`'s doc comment in `mcp/auth.ts` for why an admin-issued key
 * cannot write) — plus `write:assets` on the destination folder, addressed exactly as
 * `helpers/pageAccess.ts#mayOnAsset` addresses it. That helper takes a `FastifyRequest` and so cannot
 * be called directly from an MCP tool; the check is inlined here the same way `create_page`/
 * `update_page` inline their own `write:pages` check rather than reusing a `req`-shaped helper.
 *
 * `content` arrives base64-encoded because MCP tool arguments are JSON — the same direction
 * `render_diagram` already returns image bytes in, just reversed. There is no HTTP body-limit
 * middleware backing a JSON-RPC call the way `api/assets.ts`'s content-type parser caps the REST
 * route's body, so the decoded size is checked by hand against the same
 * `security.uploadMaxFileSize` setting.
 *
 * `folderId`/`parentPath` resolution mirrors the REST route's own logic exactly (folderId wins when
 * given; an unknown or cross-site folderId is refused rather than silently uploading to the root,
 * matching OpenProject #2127/#2131; `parentPath` creates any missing ancestor folder) so the same
 * call made through either surface behaves identically.
 */
export async function handleUploadAsset(
  ctx: McpAuthContext,
  args: UploadAssetArgs
): Promise<CallToolResult> {
  const site = resolveRequestedSite(ctx, args.siteId)
  if (!ctx.userId) {
    throw new McpToolError(
      'Uploading an asset requires a personal access token — an admin-issued key has no user to attribute the upload to.'
    )
  }

  const data = Buffer.from(args.content, 'base64')
  if (data.length < 1) {
    throw new McpToolError('No file content was sent.')
  }
  const maxFileSize = WIKI.config.security?.uploadMaxFileSize ?? 10485760
  if (data.length > maxFileSize) {
    throw new McpToolError(
      `This file (${data.length} bytes) exceeds the ${maxFileSize}-byte upload limit for this instance.`
    )
  }

  const locale = args.locale || site.config.locales?.primary || 'en'

  // -> Scoped by siteId (mirrors OpenProject #2127): a caller-supplied folderId belonging to another
  //    site resolves to nothing here, same as an unknown id.
  const folder = args.folderId ? await WIKI.models.tree.getFolderById(args.folderId, site.id) : null
  if (args.folderId && !folder) {
    throw new McpToolError('This folder does not exist.')
  }
  const folderPath = folder ? (decodeTreePath(folder.folderPath ?? '') ?? '') : ''
  const parentPath = args.parentPath ? normalizePagePath(args.parentPath) : ''
  const destination = args.folderId
    ? [folderPath, folder!.fileName].filter(Boolean).join('/')
    : parentPath

  if (
    !WIKI.models.groups.checkAccess(actorFor(ctx), 'write:assets', {
      path: destination ? `${destination}/${args.fileName}` : args.fileName,
      siteId: site.id,
      locale,
      // -> An asset carries no classification of its own -- see `mayOnAsset`'s own doc comment.
      classification: null
    })
  ) {
    throw new McpToolError('You are not allowed to upload a file here.')
  }

  // -> `folder`, not the raw `args.folderId`: an id that resolved to nothing must never reach
  //    `upload()` as a parent (it can't, since it was already refused above, but this keeps the
  //    invariant explicit the way `api/assets.ts` does).
  const folderId = args.folderId
    ? folder!.id
    : parentPath
      ? (
          await WIKI.models.tree.getFolder({
            path: parentPath,
            locale,
            siteId: site.id,
            createIfMissing: true
          })
        ).id
      : undefined

  let asset
  try {
    asset = await WIKI.models.assets.upload({
      siteId: site.id,
      locale,
      folderId,
      fileName: args.fileName,
      mimeType: args.mimeType,
      data,
      authorId: ctx.userId
    })
  } catch (err: any) {
    throw new McpToolError(err.message)
  }

  // -> #1118: same instance-wide-visibility reasoning as `create_page`/`update_page`'s own
  //   instrumentation, extended to the asset write tools.
  await WIKI.models.auditLog.record({
    event: 'mcp.writeToolCalled',
    actor: auditActorFor(ctx),
    targetType: 'asset',
    targetId: asset.id,
    targetLabel: asset.fileName,
    detail: { tool: 'upload_asset' },
    siteId: site.id
  })

  return toResult({
    id: asset.id,
    fileName: asset.fileName,
    folderPath: asset.folderPath,
    mimeType: asset.mimeType,
    fileSize: asset.fileSize,
    kind: asset.kind,
    locale: asset.locale,
    updatedAt: asset.updatedAt
  })
}

export function registerUploadAssetTool(server: McpServer, getCtx: McpAuthContextGetter): void {
  server.registerTool(
    'upload_asset',
    {
      description:
        'Upload a file to the asset library. `content` is the file bytes, base64-encoded. Requires a personal access token — the upload is attributed to its owner — and `write:assets` on the destination folder.',
      inputSchema: uploadAssetInputSchema
    },
    (args) => handleUploadAsset(getCtx(), args)
  )
}
