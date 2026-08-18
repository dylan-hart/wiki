import type { WikiDb, WikiDbOrTx } from '../core/db.ts'
import type { SystemIds } from '../models/types.ts'
import {
  createAssetImportSummary,
  writeImportedAsset,
  type AssetImportSummary,
  type SourceAssetRecord,
  type WriteImportedAssetOptions
} from './assets.ts'

/**
 * How many assets one batch writes at most, absent an override. Chosen as a round number small
 * enough that a batch's own transaction never holds a connection open for long, not for any memory
 * reason — `maxBatchBytes` is what actually bounds memory.
 */
export const DEFAULT_MAX_BATCH_ITEMS = 50

/**
 * How many cumulative bytes of file content one batch writes at most, absent an override. This is
 * the real memory bound: a batch never buffers more than roughly this many bytes of asset data at
 * once, because items within a batch are written one at a time (see `writeImportedAsset`'s own
 * single-buffer-at-a-time note) and the next batch does not start accumulating until this one's
 * transaction has committed or rolled back.
 */
export const DEFAULT_MAX_BATCH_BYTES = 200 * 1024 * 1024

/**
 * Per-file size ceiling, absent an override. 3.0's `assets.data` column (a `bytea`) has no size guard
 * of its own — see the task this constant was added for — so without one, a single unusually large
 * source file would defeat every batching decision above it by trying to buffer itself whole.
 * A few hundred MB comfortably covers ordinary uploads (video, disk images, archives) while still
 * catching the pathological case; 421's CLI is expected to expose this as a `--max-file-size` flag
 * via `AssetBatchOptions.maxFileSizeBytes` rather than hardcode it.
 */
export const DEFAULT_MAX_FILE_SIZE_BYTES = 300 * 1024 * 1024

export interface FailedAssetBatch {
  /** 1-based — the first batch a run attempts is batch 1, matching how an operator would refer to
   *  "the third batch" out loud. */
  batchIndex: number
  sourceIds: string[]
  error: string
}

export interface AssetBatchImportSummary extends AssetImportSummary {
  /** One entry per batch whose transaction rolled back. Every `sourceId` in a listed batch is exactly
   *  as unimported as it was before the run started — see the module doc comment on why a batch is
   *  all-or-nothing rather than retried item-by-item. */
  failedBatches: FailedAssetBatch[]
}

/** A fresh, empty summary to accumulate a batched asset import run into. */
export function createAssetBatchImportSummary(): AssetBatchImportSummary {
  return { ...createAssetImportSummary(), failedBatches: [] }
}

export interface AssetBatchOptions extends Omit<WriteImportedAssetOptions, 'db'> {
  /** @default DEFAULT_MAX_BATCH_ITEMS */
  maxBatchItems?: number
  /** @default DEFAULT_MAX_BATCH_BYTES */
  maxBatchBytes?: number
  /** @default DEFAULT_MAX_FILE_SIZE_BYTES */
  maxFileSizeBytes?: number
  /** Runs every batch's transaction against this instead of the ambient `WIKI.db` — a test seam; a
   *  real caller has no reason to override it, since the whole point of a per-batch transaction is
   *  that the runner opens one itself. */
  db?: WikiDb
}

/**
 * Import a stream of normalized source-asset records in bounded-size batches, so the writer never
 * holds more than one batch's worth of file bytes in memory — and, within a batch, never more than
 * one item's, since `writeImportedAsset` writes items one at a time — rather than the whole run's
 * assets sitting in memory (or in one all-or-nothing transaction) at once.
 *
 * A batch closes, and is handed to `WIKI.db.transaction()`, as soon as either bound is hit:
 * `maxBatchItems` records accumulated, or `maxBatchBytes` of cumulative `fileSize` accumulated —
 * whichever comes first. A record whose own `fileSize` exceeds `maxFileSizeBytes` is never added to a
 * batch at all: it is recorded on `summary.skippedOversize` (with its bytes never read) and skipped,
 * exactly the "log-and-skip-with-reason" the task asked for instead of risking an OOM on one huge
 * file.
 *
 * **Batch failure: fail-the-batch-and-report, not retry-item-by-item.** If any item in a batch throws
 * — a constraint violation, a bad record, anything `writeImportedAsset` does not itself recover from
 * — the whole batch's transaction rolls back (so a batch is genuinely atomic: none of its items are
 * half-committed) and the batch is recorded on `summary.failedBatches` with every one of its source
 * ids. The runner then moves on to the *next* batch rather than aborting the run, on the theory that
 * one bad record in a large import should not sacrifice every asset after it — the run's caller
 * decides what to do about a non-empty `failedBatches` (surface it, retry the whole run, whatever
 * 421's CLI wants to make of it).
 *
 * That "move on" is safe to do — and safe for the caller to retry the whole run afterward — only
 * because `writeImportedAsset` is idempotent by construction (see its own doc comment): every batch
 * before the failed one already committed, and every asset in it now exists under its
 * `deterministicAssetId`. A re-run (whether "just retry the whole thing" or something smarter 421
 * builds later) walks straight past every already-committed neighbor via `summary.alreadyImported`
 * and only actually writes what the failed batch never got to keep.
 */
export async function importAssetsInBatches(
  records: AsyncIterable<SourceAssetRecord> | Iterable<SourceAssetRecord>,
  systemIds: SystemIds,
  summary: AssetBatchImportSummary,
  options: AssetBatchOptions = {}
): Promise<void> {
  const maxBatchItems = options.maxBatchItems ?? DEFAULT_MAX_BATCH_ITEMS
  const maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES
  const maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES
  const db: WikiDb = options.db ?? WIKI.db

  let batch: SourceAssetRecord[] = []
  let batchBytes = 0
  let batchIndex = 0

  const flush = async (): Promise<void> => {
    if (batch.length === 0) {
      return
    }
    const current = batch
    batch = []
    batchBytes = 0
    batchIndex++

    try {
      await db.transaction(async (tx: WikiDbOrTx) => {
        for (const record of current) {
          await writeImportedAsset(record, systemIds, summary, {
            makeThumbnail: options.makeThumbnail,
            db: tx
          })
        }
      })
    } catch (err: any) {
      summary.failedBatches.push({
        batchIndex,
        sourceIds: current.map((record) => record.sourceId),
        error: err?.message ?? String(err)
      })
      WIKI.logger.error(
        `Asset import batch ${batchIndex} (${current.length} item(s)) failed and was rolled back: ${err?.message ?? err}`
      )
    }
  }

  for await (const record of records) {
    if (record.fileSize > maxFileSizeBytes) {
      summary.skippedOversize.push({
        sourceId: record.sourceId,
        fileName: record.filename,
        siteId: record.siteId,
        fileSize: record.fileSize,
        reason: `fileSize ${record.fileSize} exceeds the configured maxFileSizeBytes of ${maxFileSizeBytes}`
      })
      continue
    }

    batch.push(record)
    batchBytes += record.fileSize

    if (batch.length >= maxBatchItems || batchBytes >= maxBatchBytes) {
      await flush()
    }
  }

  await flush()
}
