import { resolveActorId } from '../id-map.ts'
import type { UserIdMap } from '../id-map.ts'
import type { SourceAssetFile } from '../connector.ts'

export interface UploadedAsset {
  id: string
  fileName: string
}

/**
 * The one method this module needs off `models/assets.ts#upload()` — a structural subset (not an
 * import of the real `Asset`/upload-args types) so a test can hand this a fake without pulling in the
 * real model. `folderId?: string | null` matches the real signature: `undefined` (a root-level asset)
 * and `null` (an explicit "no folder") are both accepted, mirroring `models/assets.ts`'s own optional
 * `folderId` parameter.
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
  }): Promise<UploadedAsset>
}

/** The one method this module needs off `models/tree.ts#getFolder()` — same structural-subset
 * reasoning as `AssetsWriteModel`. The real method's `path` is `path?: string | null`; only the
 * `path`/`locale`/`siteId`/`createIfMissing` fields this module actually passes are declared here. */
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
  // -> `UserIdMap` (`id-map.ts`): the same read-only "old numeric id -> new UUID" structural contract
  //    `content-staging.ts#ContentStagingOptions.userIdMap` uses, rather than the concrete
  //    `Map<number, string>` the `users` phase (Task 14) builds and populates — this module only ever
  //    calls `.get()`, and the narrower type is what lets a caller hand in a hand-built fallback
  //    (`ctx.userIdMap ?? new Map()`, for a `MigrationContext` that never ran the `users` phase).
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
 * file name.
 *
 * Adapted from the design brief's sketch (which derived both halves by splitting `relativePath` on its
 * last `/`): the real `SourceAssetFile` (`connector.ts`) already carries the bare name separately as
 * `filename`, and the real `PostgresSourceConnector#assets()` builds `relativePath` as exactly
 * `` `${folderPath}/${filename}` `` (folder present) or `filename` alone (root-level) — see
 * `connectors/postgres.ts`. Using `file.filename` directly and stripping only its own `/${filename}`
 * suffix off `relativePath` is equivalent for every real connector output and additionally correct if
 * a future connector's folder path itself ever contained a `/`-adjacent quirk that a blind
 * `lastIndexOf('/')` split on `relativePath` alone could not disambiguate from the file name.
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

/** Reads a `Readable` fully into a `Buffer` — asset bytes are already bounded by whatever the source
 * connector chose to stream one file at a time (Task 10's `assets()`), so buffering one file per call
 * is the same memory profile `models/assets.ts#upload()` already assumes for a live upload. */
async function bufferStream(stream: SourceAssetFile['stream']): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/** Imports one 2.x asset file through `models/assets.ts#upload()` — the same path a live upload takes
 * (tree row + assets row + thumbnail generation), per the design spec's "lean on the existing upload
 * path rather than hand-rolling a second writer" decision. Resolves the file's folder path via
 * `deps.treeModel.getFolder({ createIfMissing: true })`, which already auto-creates any missing
 * ancestor folder (`models/tree.ts`), so this module never creates a folder row itself — only called
 * for a nested asset; a root-level asset passes `folderId: undefined` straight through, matching
 * `models/assets.ts#upload()`'s own "the site root when absent" contract.
 *
 * Asset `createdAt`/`updatedAt` cannot be preserved — `upload()` has no parameter for it (unlike
 * `createPage()`) — so an imported asset's timestamps are always "now," not the source's real dates.
 * This is a documented, accepted gap (see `docs/variances.md`'s asset-import-timestamps entry).
 */
export async function importAsset(
  file: SourceAssetFile,
  deps: AssetImportDeps,
  options: AssetImportOptions
): Promise<
  | { result: 'success'; success: AssetImportSuccess }
  | { result: 'failure'; failure: AssetImportFailure }
> {
  // -> Guards the whole-record case (`file` itself null/undefined) the same way `phases/assets.ts`'s
  //    own `classify` guards its identifier expression (`file?.relativePath`) — not reachable from
  //    either real connector today (`PostgresSourceConnector#assets()` always yields a real object),
  //    but cheap enough to make this function safe to call with an untrusted `record as SourceAssetFile`
  //    cast without relying on the caller having already checked.
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

  // -> `file.relativePath` stands in for this record's identifier throughout — guarded against a
  //    malformed source row (e.g. missing entirely) the same way `phases/assets.ts`'s own `classify`
  //    guards its own identifier, so a bad record reports a clean 'read-error' rather than crashing on
  //    `undefined.length` deep inside `resolveAssetLocation()`/string interpolation below.
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

  let folder: { id: string } | null
  try {
    folder = folderPath
      ? await deps.treeModel.getFolder({
          path: folderPath,
          locale: options.locale,
          siteId: options.siteId,
          createIfMissing: true
        })
      : null
  } catch (err: any) {
    return {
      result: 'failure',
      failure: { relativePath, reason: 'folder-error', message: err.message }
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
      authorId: actor.actorId
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
