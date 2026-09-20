import path from 'node:path'
import { and, asc, eq, gt } from 'drizzle-orm'
import type Client from 'ssh2-sftp-client'
import { assets as assetsTable, tree as treeTable } from '../../../db/schema.ts'
import { decodeTreePath } from '../../../helpers/common.ts'
import { belongsInTarget } from '../../../helpers/blobTarget.ts'
import { ensureDirectory } from './connection.ts'
import type { AssetContentCategory } from '../../../helpers/blobTarget.ts'
import type { AssetKind } from '../../../models/assets.ts'
import type { StorageTarget } from '../../../models/storage.ts'

/**
 * Smaller than `pages.ts`'s `PAGE_BATCH_SIZE`: `assets.data` is `bytea` and a single row can be many
 * megabytes, where a page's `content` is realistically always text-sized. Bounding how much raw file
 * data sits in memory at once is the entire reason this is keyset-paginated rather than one
 * `SELECT * FROM assets WHERE "siteId" = ...`.
 */
const ASSET_BATCH_SIZE = 50

export interface AssetExportRow {
  id: string
  fileName: string
  /** Slash-separated, without a leading or trailing slash. Empty at the site root. */
  folderPath: string
  kind: AssetKind
  fileSize: number
  data: Buffer | null
}

export type AssetBatchFetcher = (params: {
  siteId: string
  afterId: string | null
  pageSize: number
}) => Promise<AssetExportRow[]>

/**
 * Keyset-paginated on `id` because this fork's plain `pg`/Drizzle setup has no `.stream()`, so a
 * fixed-size batch is what keeps a full export from holding the whole table (bytea included) in
 * memory. `folderPath` lives on the `tree` row rather than on `assets` — the two share an id —
 * hence the join and `decodeTreePath` rather than re-deriving folder layout here.
 */
async function fetchAssetBatch({
  siteId,
  afterId,
  pageSize
}: {
  siteId: string
  afterId: string | null
  pageSize: number
}): Promise<AssetExportRow[]> {
  const conditions = [eq(assetsTable.siteId, siteId)]
  if (afterId) {
    conditions.push(gt(assetsTable.id, afterId))
  }
  const rows = await CARDINAL.db
    .select({
      id: assetsTable.id,
      fileName: assetsTable.fileName,
      kind: assetsTable.kind,
      fileSize: assetsTable.fileSize,
      data: assetsTable.data,
      folderPath: treeTable.folderPath
    })
    .from(assetsTable)
    .innerJoin(treeTable, eq(treeTable.id, assetsTable.id))
    .where(and(...conditions))
    .orderBy(asc(assetsTable.id))
    .limit(pageSize)

  return rows.map((row) => ({
    ...row,
    fileSize: row.fileSize ?? 0,
    folderPath: decodeTreePath(row.folderPath ?? '') ?? ''
  }))
}

/** Relative to the target's `basePath`. */
export function remotePathForAsset(asset: Pick<AssetExportRow, 'folderPath' | 'fileName'>): string {
  return asset.folderPath ? `${asset.folderPath}/${asset.fileName}` : asset.fileName
}

/** Everything `activeTypes` can hold besides `'pages'`. */
const ASSET_CONTENT_TYPES: AssetContentCategory[] = ['images', 'documents', 'others', 'large']

/**
 * A no-op when no asset bucket is in `target.contentTypes.activeTypes` — same reasoning as
 * `exportPages`'s `'pages'` guard: an admin can turn asset sync off for this target independently of
 * the module supporting it, and `exportAll` still runs whatever other content types are enabled.
 * Otherwise every row is gated individually by `belongsInTarget`, so a target that only wants
 * `'images'` still has to fetch every asset to find them.
 *
 * @param options.onProgress Called once per batch fetched, not per asset, with the running total
 *   actually written — skipped rows do not count, and a no-op run never calls it.
 */
export async function exportAssets(
  client: Client,
  target: StorageTarget,
  options: {
    fetchBatch?: AssetBatchFetcher
    /** Overridable purely so a test can exercise multi-batch pagination without 50 fixture rows. */
    pageSize?: number
    onProgress?: (exportedCount: number) => void
  } = {}
): Promise<void> {
  const activeTypes = target.contentTypes.activeTypes
  if (!ASSET_CONTENT_TYPES.some((type) => activeTypes.includes(type))) {
    return
  }

  const fetchBatch = options.fetchBatch ?? fetchAssetBatch
  const pageSize = options.pageSize ?? ASSET_BATCH_SIZE
  const basePath = String(target.config.basePath ?? '').replace(/\/+$/, '')

  let afterId: string | null = null
  let exportedCount = 0
  for (;;) {
    const batch = await fetchBatch({ siteId: target.siteId, afterId, pageSize })
    if (batch.length === 0) {
      break
    }

    for (const asset of batch) {
      if (!belongsInTarget(asset, target.contentTypes)) {
        continue
      }
      // -> Not expected in practice — every upload writes `data` alongside its tree entry — but the
      //    column is nullable in the schema, so this loop does not assume otherwise.
      if (!asset.data) {
        continue
      }

      const remotePath = remotePathForAsset(asset)
      const remoteDir = path.posix.dirname(remotePath)
      if (remoteDir !== '.') {
        await ensureDirectory(client, basePath, remoteDir)
      }
      await client.put(asset.data, `${basePath}/${remotePath}`)
      exportedCount++
    }

    options.onProgress?.(exportedCount)

    afterId = batch[batch.length - 1].id
    if (batch.length < pageSize) {
      break
    }
  }
}
