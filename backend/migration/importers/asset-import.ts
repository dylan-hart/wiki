import { resolveActorId } from '../id-map.ts'
import { normalizeMigratedPath } from '../path-normalization.ts'
import type { UserIdMap } from '../id-map.ts'
import type { SourceAssetFile } from '../connector.ts'

export interface UploadedAsset {
  id: string
  fileName: string
}

/**
 * The one method this module needs off `models/assets.ts#upload()`, declared structurally so a test
 * can hand it a fake without pulling in the real model. `folderId?: string | null` mirrors the real
 * signature: `undefined` (a root-level asset) and `null` (an explicit "no folder") are both
 * accepted.
 */
export interface AssetsWriteModel {
  upload(input: {
    siteId: string
    locale: string
    folderId?: string | null
    fileName: string
    mimeType?: string | null
    data: Buffer
    authorId: string
    createdAt?: string
    updatedAt?: string
  }): Promise<UploadedAsset>
}

/** The one method this module needs off `models/tree.ts#getFolder()`, declared structurally for the
 * same reason as `AssetsWriteModel` and carrying only the fields this module passes. */
export interface TreeFolderModel {
  getFolder(input: {
    path?: string | null
    locale?: string
    siteId: string
    createIfMissing?: boolean
  }): Promise<{ id: string }>
}

export interface AssetImportDeps {
  assetsModel: AssetsWriteModel
  treeModel: TreeFolderModel
}

export interface AssetImportOptions {
  siteId: string
  locale: string
  // -> Narrower than the concrete `Map<number, string>` the `users` phase builds: this module only
  //    calls `.get()`, so a caller may hand in a bare `ctx.userIdMap ?? new Map()` fallback.
  userIdMap: UserIdMap
  fallbackActorId: string
}

export type AssetImportFailureReason = 'read-error' | 'folder-error' | 'upload-error'

export interface AssetImportFailure {
  relativePath: string
  reason: AssetImportFailureReason
  message: string
}

export interface AssetImportSuccess {
  relativePath: string
  assetId: string
  warnings: string[]
}

/**
 * Splits one `SourceAssetFile` into a folder path (`undefined` for a root-level asset) and the bare
 * file name. `folderPath` comes back raw — a 2.x path may use characters 3.0's `rePathName`
 * disallows — and is normalized by `importAsset` instead, immediately before `getFolder()`.
 *
 * Stripping the already-known `filename` off `relativePath`, rather than splitting on its last `/`,
 * keeps this correct for a folder path a blind split could not tell apart from the file name.
 */
function resolveAssetLocation(file: SourceAssetFile): { folderPath?: string; fileName: string } {
  const fileName = typeof file.filename === 'string' ? file.filename : ''
  const relativePath = typeof file.relativePath === 'string' ? file.relativePath : fileName
  const suffix = `/${fileName}`
  if (fileName && relativePath.length > suffix.length && relativePath.endsWith(suffix)) {
    return { folderPath: relativePath.slice(0, -suffix.length), fileName }
  }
  return { fileName }
}

/** Buffering one whole file is the same memory profile `models/assets.ts#upload()` already assumes
 * for a live upload, and the connector hands them over one at a time. */
async function bufferStream(stream: SourceAssetFile['stream']): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/** Imports one 2.x asset through `models/assets.ts#upload()` — the same path a live upload takes
 * (tree row + assets row + thumbnail), rather than a second hand-rolled writer. A nested asset's raw
 * `folderPath` is folded through `normalizeMigratedPath()` first, then resolved with
 * `createIfMissing: true`, which auto-creates any missing ancestor, so this module never writes a
 * folder row itself; a path that cannot fold to a valid 3.0 folder name reports the same
 * `'folder-error'` a `getFolder()` rejection does, not a failure kind of its own.
 *
 * `file.createdAt`/`file.updatedAt` (the Postgres-direct connector only — a bundle carries no
 * per-asset metadata) go through `upload()`'s override params so an imported asset keeps the
 * source's own dates; absent, the destination row keeps `upload()`'s `now()` default.
 */
export async function importAsset(
  file: SourceAssetFile,
  deps: AssetImportDeps,
  options: AssetImportOptions
): Promise<
  | { result: 'success'; success: AssetImportSuccess }
  | { result: 'failure'; failure: AssetImportFailure }
> {
  // -> Unreachable from either real connector; kept so an untrusted `record as SourceAssetFile`
  //    cast is safe to pass without the caller having checked first.
  if (!file || typeof file !== 'object') {
    return {
      result: 'failure',
      failure: {
        relativePath: 'unknown',
        reason: 'read-error',
        message: 'received a malformed asset record (not an object) — nothing to read.'
      }
    }
  }

  // -> Stands in as this record's identifier throughout, so a malformed row reports a clean
  //    'read-error' rather than crashing on `undefined` further down.
  const relativePath = typeof file.relativePath === 'string' ? file.relativePath : 'unknown'
  const { folderPath, fileName } = resolveAssetLocation(file)
  const warnings: string[] = []

  let data: Buffer
  try {
    data = await bufferStream(file.stream)
  } catch (err: any) {
    return {
      result: 'failure',
      failure: { relativePath, reason: 'read-error', message: err.message }
    }
  }

  const actor = resolveActorId(file.authorId ?? null, options.userIdMap, options.fallbackActorId)
  if (actor.usedFallback) {
    warnings.push(
      `asset ${relativePath}: authorId has no entry in the user id map — falling back to the operator actor.`
    )
  }

  let folder: { id: string } | null = null
  if (folderPath) {
    const normalizedFolder = normalizeMigratedPath(folderPath)
    if ('reason' in normalizedFolder) {
      return {
        result: 'failure',
        failure: {
          relativePath,
          reason: 'folder-error',
          message: `asset folder path "${folderPath}" could not be placed in the tree: ${normalizedFolder.message}`
        }
      }
    }
    try {
      folder = await deps.treeModel.getFolder({
        path: normalizedFolder.path,
        locale: options.locale,
        siteId: options.siteId,
        createIfMissing: true
      })
    } catch (err: any) {
      return {
        result: 'failure',
        failure: { relativePath, reason: 'folder-error', message: err.message }
      }
    }
  }

  try {
    const uploaded = await deps.assetsModel.upload({
      siteId: options.siteId,
      locale: options.locale,
      folderId: folder?.id,
      fileName,
      mimeType: file.mimeType,
      data,
      authorId: actor.actorId,
      createdAt: file.createdAt?.toISOString(),
      updatedAt: file.updatedAt?.toISOString()
    })

    return {
      result: 'success',
      success: { relativePath, assetId: uploaded.id, warnings }
    }
  } catch (err: any) {
    return {
      result: 'failure',
      failure: { relativePath, reason: 'upload-error', message: err.message }
    }
  }
}
