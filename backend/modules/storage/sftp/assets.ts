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
 * Writing a site's assets to an SFTP target as files — the asset half of the `exportAll` action,
 * alongside `pages.ts` (Task 522). Wiring both into `exportAll` itself with connection setup and
 * logging is Task 524, built on top of this.
 */

/**
 * How many rows one batch pulls from Postgres.
 *
 * Smaller than `pages.ts`'s `PAGE_BATCH_SIZE` (200): `assets.data` is `bytea` and a single row can be
 * many megabytes, where a page's `content` is realistically always text-sized. Keeping the batch
 * smaller bounds how much raw file data sits in memory at once, which is the entire reason this
 * exists as keyset pagination rather than one `SELECT * FROM assets WHERE "siteId" = ...`.
 */
const ASSET_BATCH_SIZE = 50

/** The columns `exportAssets` needs off an asset row, folder layout already resolved. */
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
 * One page of a site's assets, keyset-paginated on `id` for the same reason `pages.ts`'s
 * `fetchPageBatch` is: no `.stream()` in this fork's plain `pg`/Drizzle setup, so a fixed-size batch
 * is what keeps a full export from holding the whole table (bytea included) in memory at once.
 *
 * `folderPath` lives on the `tree` row rather than on `assets` — the two share an ID — so this joins
 * the same way `models/assets.ts`'s `getAsset`/`getAssetByPath` already do, and decodes it with the
 * same `decodeTreePath` helper, rather than re-deriving folder layout here.
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
  const rows = await WIKI.db
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

/**
 * The path an asset is written to on the remote target, relative to the target's `basePath`:
 * `<folderPath>/<fileName>` when the asset sits in a folder, else plain `<fileName>` at the root.
 */
export function remotePathForAsset(asset: Pick<AssetExportRow, 'folderPath' | 'fileName'>): string {
  return asset.folderPath ? `${asset.folderPath}/${asset.fileName}` : asset.fileName
}

/** The asset-facing content type buckets — everything `activeTypes` can hold besides `'pages'`. */
const ASSET_CONTENT_TYPES: AssetContentCategory[] = ['images', 'documents', 'others', 'large']

/**
 * Write every eligible asset of a site to an SFTP target, batching reads so a large wiki's asset
 * bytes never sit fully in memory at once.
 *
 * A no-op when none of `'images' | 'documents' | 'others' | 'large'` is in
 * `target.contentTypes.activeTypes` — same reasoning as `exportPages`'s `'pages'` guard: an admin can
 * turn asset sync off for this target independently of the module supporting it, and `exportAll` is
 * expected to still run whatever other content types are enabled. Where at least one asset bucket is
 * active, each row is still individually gated by `helpers/blobTarget.ts`'s `belongsInTarget` — the
 * same gate `models/storage.ts`'s write-path dispatch and the blob targets' own `exportAll` use — so a
 * target that only wants `'images'` still has to fetch every asset to find them, but writes none of
 * the rest.
 *
 * @param client A connected SFTP client, e.g. from `connectSftp`.
 * @param target The site's configured target; `target.config.basePath` is where files land, and
 *   `target.siteId` is which site's assets get exported.
 * @param options.fetchBatch Defaults to a real `WIKI.db` query; override in tests.
 * @param options.onProgress Called once per batch fetched (not per asset) with the running total of
 *   assets actually written (skipped rows — inactive bucket, no data — don't count), so a caller can
 *   log progress at a granularity useful for a large export. Never called for a no-op run (no asset
 *   content type active, or zero rows).
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
      // -> Nothing to write for a row with no bytes stored — not expected in practice (every upload
      //    writes `data` alongside its tree entry), but a null column is the schema's own contract,
      //    not an invariant this loop should assume.
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
