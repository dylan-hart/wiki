import path from 'node:path'
import { and, asc, eq, gt } from 'drizzle-orm'
import type Client from 'ssh2-sftp-client'
import { assets as assetsTable, tree as treeTable } from '../../../db/schema.ts'
import { decodeTreePath } from '../../../helpers/common.ts'
import { ensureDirectory } from './connection.ts'
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

/**
 * Multipliers for `parseSizeToBytes`, decimal (1000-based) rather than binary (1024-based) — matching
 * how the `filesize` package this backend already depends on (`api/system.ts`) formats bytes back
 * into `MB`/`GB` by default, so a threshold typed as "5MB" here means the same 5,000,000 bytes it
 * would if this repo ever displayed one back to an admin.
 */
const SIZE_UNIT_MULTIPLIERS: Record<string, number> = {
  B: 1,
  KB: 1_000,
  MB: 1_000 ** 2,
  GB: 1_000 ** 3,
  TB: 1_000 ** 4
}

/**
 * Parse a `contentTypes.largeThreshold`-shaped string (`"5MB"`, `"512B"`, `"1.5 GB"`) into bytes.
 *
 * The format accepted mirrors the exact regex `models/storage.ts` validates a target's threshold
 * against before it is ever saved (`/^\d+(\.\d+)?\s?(B|KB|MB|GB|TB)$/i`), so anything already sitting
 * on a `StorageTarget` is guaranteed to parse.
 */
export function parseSizeToBytes(threshold: string): number {
  const match = /^(\d+(?:\.\d+)?)\s?(B|KB|MB|GB|TB)$/i.exec(threshold.trim())
  if (!match) {
    throw new Error(`"${threshold}" is not a valid size threshold. Use a size such as "5MB".`)
  }
  const [, amount, unit] = match
  return Math.round(Number.parseFloat(amount) * SIZE_UNIT_MULTIPLIERS[unit.toUpperCase()])
}

/**
 * Maps an asset's `kind` column (`assetKindEnum` — `'document' | 'image' | 'other'`) onto the
 * content-type bucket names `contentTypes.activeTypes` is expressed in (`'documents' | 'images' |
 * 'others'`).
 *
 * No such mapping exists anywhere else in the codebase to reuse: Feature 368 (Disk & DB target) has
 * not generalized one — its module directory holds only a `definition.yml`, no `storage.ts` — so this
 * stays local to the `sftp` module rather than invented speculatively for a consumer that doesn't
 * exist yet.
 */
const ASSET_KIND_CONTENT_TYPES: Record<AssetKind, string> = {
  image: 'images',
  document: 'documents',
  other: 'others'
}

/**
 * Which `contentTypes.activeTypes` bucket an asset falls under.
 *
 * `'large'` takes precedence over the kind-based bucket once `fileSize` is *above* `largeThresholdBytes`
 * (strictly greater than — matching the api schema's own wording, "size above which an asset counts
 * as a large file"), regardless of whether it's an image, document, or other file. Under the
 * threshold, it falls back to its kind's bucket.
 */
export function contentTypeBucketForAsset(
  asset: Pick<AssetExportRow, 'kind' | 'fileSize'>,
  largeThresholdBytes: number
): string {
  if (asset.fileSize > largeThresholdBytes) {
    return 'large'
  }
  return ASSET_KIND_CONTENT_TYPES[asset.kind]
}

/** The asset-facing content type buckets — everything `activeTypes` can hold besides `'pages'`. */
const ASSET_CONTENT_TYPES = ['images', 'documents', 'others', 'large']

/**
 * Write every eligible asset of a site to an SFTP target, batching reads so a large wiki's asset
 * bytes never sit fully in memory at once.
 *
 * A no-op when none of `'images' | 'documents' | 'others' | 'large'` is in
 * `target.contentTypes.activeTypes` — same reasoning as `exportPages`'s `'pages'` guard: an admin can
 * turn asset sync off for this target independently of the module supporting it, and `exportAll` is
 * expected to still run whatever other content types are enabled. Where at least one asset bucket is
 * active, each row is still individually gated by `contentTypeBucketForAsset` — a target that only
 * wants `'images'` still has to fetch every asset to find them, but writes none of the rest.
 *
 * @param client A connected SFTP client, e.g. from `connectSftp`.
 * @param target The site's configured target; `target.config.basePath` is where files land, and
 *   `target.siteId` is which site's assets get exported.
 * @param options.fetchBatch Defaults to a real `WIKI.db` query; override in tests.
 */
export async function exportAssets(
  client: Client,
  target: StorageTarget,
  options: {
    fetchBatch?: AssetBatchFetcher
    /** Overridable purely so a test can exercise multi-batch pagination without 50 fixture rows. */
    pageSize?: number
  } = {}
): Promise<void> {
  const activeTypes = target.contentTypes.activeTypes
  if (!ASSET_CONTENT_TYPES.some((type) => activeTypes.includes(type))) {
    return
  }

  const fetchBatch = options.fetchBatch ?? fetchAssetBatch
  const pageSize = options.pageSize ?? ASSET_BATCH_SIZE
  const basePath = String(target.config.basePath ?? '').replace(/\/+$/, '')
  const largeThresholdBytes = parseSizeToBytes(target.contentTypes.largeThreshold)

  let afterId: string | null = null
  for (;;) {
    const batch = await fetchBatch({ siteId: target.siteId, afterId, pageSize })
    if (batch.length === 0) {
      break
    }

    for (const asset of batch) {
      const bucket = contentTypeBucketForAsset(asset, largeThresholdBytes)
      if (!activeTypes.includes(bucket)) {
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
    }

    afterId = batch[batch.length - 1].id
    if (batch.length < pageSize) {
      break
    }
  }
}
