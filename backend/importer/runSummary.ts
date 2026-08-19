import mime from 'mime'
import type { SystemIds } from '../models/types.ts'
import {
  createAssetBatchImportSummary,
  importAssetsInBatches,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  type AssetBatchImportSummary,
  type AssetBatchOptions
} from './assetBatch.ts'
import { bufferOf, type SourceAssetRecord } from './assets.ts'
import type {
  CommentsStagingManifest,
  PageIdMap,
  SourceCommentRecord,
  StagedComment,
  UserIdMap
} from './comments.ts'
import { writeCommentsStagingBundle } from './comments.ts'

/**
 * The one report shape this task exists to give feature 421's CLI: `validateAssets`/`validateComments`
 * (dry-run — nothing written) and `applyAssets`/`applyComments` (real run — writes via the modules
 * Tasks 747/750/752/755 already built) both accumulate into the *same* `ImportRunSummary` object, so a
 * caller renders one thing regardless of which mode it ran. Neither function pair mutates the other's
 * half of the object — a caller free to run dry-run validation for assets and a real run for comments
 * (or any other combination) into one shared summary and get one coherent report back.
 */

export type ImportRunMode = 'dry-run' | 'apply'
export type ImportCategory = 'asset' | 'comment'
export type ImportItemSeverity = 'error' | 'warning'

/**
 * One per-item detail, carrying enough context (source id, a path/name to recognize the item by, and
 * a human reason) that an operator reading a rendered summary can act on it without going back to the
 * source. `severity: 'error'` means the item was not (or, in dry-run, would not have been) imported;
 * `'warning'` means it was (or would have been) imported anyway, with some kind of substitution or
 * orphaning recorded — the same "log-and-continue, don't fail the item" posture `writeImportedAsset`
 * and `stageComment` already established.
 */
export interface ImportItemDetail {
  category: ImportCategory
  /** The source connector/record's own stable id, stringified — a 2.x integer for a comment, the
   *  normalized pipeline's `sourceId` for an asset. Never a 3.0 UUID: the point is to let an operator
   *  find this row back at the source. */
  sourceId: string
  /** A file name/path (asset) or a `page:<id>`-style locator (comment), when one is meaningful for
   *  this item — `null` when nothing better than the bare `sourceId` identifies it. */
  path: string | null
  severity: ImportItemSeverity
  reason: string
}

/** One category's running counts. `byteTotal` only ever accumulates for assets — see the field's own
 *  note — but is kept on both categories so a renderer can treat every category identically instead
 *  of special-casing which ones happen to carry a byte size. */
export interface ImportCategoryCounts {
  /** Written for real (`apply`), or would have been written without issue (`dry-run`). Includes an
   *  item that only earned a `warning` — a warning never fails an item, matching every existing writer
   *  in this feature. */
  imported: number
  /** Deliberately excluded before ever reading its bytes/content — currently only assets' oversize
   *  guard (`importer/assetBatch.ts`'s `maxFileSizeBytes`) produces this. */
  skipped: number
  /** Carries at least one `severity: 'error'` item. */
  failed: number
  /** Sum of `fileSize` across every asset counted in `imported` — the "how much data actually moved"
   *  figure the task asked for. Always `0` for comments: a comment's `content` has no size figure
   *  this feature is asked to total, so the field is kept (rather than typed away) purely for shape
   *  parity between the two categories. */
  byteTotal: number
}

export interface ImportRunSummary {
  mode: ImportRunMode
  assets: ImportCategoryCounts
  comments: ImportCategoryCounts
  items: ImportItemDetail[]
}

function emptyCategoryCounts(): ImportCategoryCounts {
  return { imported: 0, skipped: 0, failed: 0, byteTotal: 0 }
}

/** A fresh, empty summary — pass the same object into any mix of `validate*`/`apply*` calls below to
 *  accumulate one run-level report across both categories. */
export function createImportRunSummary(mode: ImportRunMode): ImportRunSummary {
  return { mode, assets: emptyCategoryCounts(), comments: emptyCategoryCounts(), items: [] }
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/** Mirrors `models/tree.ts`'s module-private `rePathName` (a folder path segment is lowercase
 *  alphanumeric-and-hyphens only) — same duplication-by-hand `importer/assetFolders.ts` already
 *  accepted for the same reason: `tree.ts` doesn't export it, and reaching into that model just to
 *  read a regex literal isn't worth a new export. */
const rePathName = /^[a-z0-9-]+$/

/**
 * Whether `folderPath` is a slash-separated path `WIKI.models.tree.addAsset` can actually build —
 * every segment legal on its own, and no empty segment (a bare `''`, or `a//b`'s middle gap) hiding
 * inside it. The empty string itself (the site root) is always constructible.
 */
function isConstructibleFolderPath(folderPath: string): boolean {
  if (folderPath === '') {
    return true
  }
  return folderPath.split('/').every((segment) => rePathName.test(segment))
}

function assetItemPath(record: SourceAssetRecord): string {
  return record.folderPath ? `${record.folderPath}/${record.filename}` : record.filename
}

/**
 * Validate one normalized source-asset record without writing anything — the dry-run counterpart to
 * `writeImportedAsset`, checking every one of this task's named conditions:
 *
 * - **target site exists**: `WIKI.sites[record.siteId]` — the same in-memory cache every other site
 *   lookup in this codebase treats as the source of truth for "is this a real, known site" (assets and
 *   tree rows carry no DB-level foreign key on `siteId`, so a bad id would not otherwise be caught
 *   before a real run's insert quietly succeeds).
 * - **bytes are actually readable**: fully reads `record.data` via `bufferOf` — the exact function
 *   `writeImportedAsset` itself reads through — so a broken/truncated `Readable` (a bad tarball
 *   handle, a DB blob that fails to stream) is caught by genuinely reading it, not merely inspecting
 *   its size. This is a *read*, never a write, so it fits "checks everything it can without writing".
 * - **mime/kind resolves**: `kindOf` (via `resolveKindAndMime`) always returns some `AssetKind`, so
 *   there is no failure state there to check — what's worth flagging is when neither the file name nor
 *   the source's own `mime` column yields anything, and resolution fell all the way to the
 *   `application/octet-stream` fallback.
 * - **folder paths are constructible**: `isConstructibleFolderPath`.
 *
 * Only a genuinely broken record (an unreadable byte source, an unconstructible path, or a target site
 * that does not exist) counts as `failed`; a mime-resolution fallback is recorded as a `warning` and
 * still counts as `imported`, matching how `writeImportedAsset` itself never fails an item over it.
 */
export async function validateAssetRecord(
  record: SourceAssetRecord,
  run: ImportRunSummary
): Promise<void> {
  const itemPath = assetItemPath(record)
  let hasError = false

  if (!WIKI.sites?.[record.siteId]) {
    hasError = true
    run.items.push({
      category: 'asset',
      sourceId: record.sourceId,
      path: itemPath,
      severity: 'error',
      reason: `target site "${record.siteId}" does not exist`
    })
  }

  let bytesReadable = true
  try {
    await bufferOf(record.data)
  } catch (err: any) {
    bytesReadable = false
    hasError = true
    run.items.push({
      category: 'asset',
      sourceId: record.sourceId,
      path: itemPath,
      severity: 'error',
      reason: `asset bytes could not be read: ${err?.message ?? err}`
    })
  }

  // -> `kindOf` (via `resolveKindAndMime`) always returns some `AssetKind` — there is no failure state
  //    to check there. What's worth flagging is the fallback one level up: neither the file name nor
  //    the source's own `mime` column yielding anything, so resolution would fall all the way to
  //    `application/octet-stream`.
  if (!mime.getType(record.filename) && !record.mime) {
    run.items.push({
      category: 'asset',
      sourceId: record.sourceId,
      path: itemPath,
      severity: 'warning',
      reason:
        'mime type could not be determined from the file name or the source mime column; ' +
        'will default to application/octet-stream'
    })
  }

  if (!isConstructibleFolderPath(record.folderPath)) {
    hasError = true
    run.items.push({
      category: 'asset',
      sourceId: record.sourceId,
      path: itemPath,
      severity: 'error',
      reason: `folderPath "${record.folderPath}" is not a constructible 3.0 tree path`
    })
  }

  if (hasError) {
    run.assets.failed++
    return
  }
  run.assets.imported++
  if (bytesReadable) {
    run.assets.byteTotal += record.fileSize
  }
}

export interface ValidateAssetsOptions {
  /** Matches `AssetBatchOptions.maxFileSizeBytes` exactly, so a dry run reports the identical set of
   *  oversize skips a real run — given the same records and the same option — would produce.
   *  @default DEFAULT_MAX_FILE_SIZE_BYTES (`importer/assetBatch.ts`) */
  maxFileSizeBytes?: number
}

/**
 * Dry-run validate a whole stream of normalized source-asset records into `run` — the counterpart to
 * `importAssetsInBatches`. An oversize record is skipped exactly as `importAssetsInBatches` skips it
 * (before ever reading its bytes); every other record is validated via `validateAssetRecord`.
 */
export async function validateAssets(
  records: AsyncIterable<SourceAssetRecord> | Iterable<SourceAssetRecord>,
  run: ImportRunSummary,
  options: ValidateAssetsOptions = {}
): Promise<void> {
  const maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES

  for await (const record of records) {
    if (record.fileSize > maxFileSizeBytes) {
      run.assets.skipped++
      run.items.push({
        category: 'asset',
        sourceId: record.sourceId,
        path: assetItemPath(record),
        severity: 'warning',
        reason: `fileSize ${record.fileSize} exceeds the configured maxFileSizeBytes of ${maxFileSizeBytes}`
      })
      continue
    }
    await validateAssetRecord(record, run)
  }
}

/** Folds one completed `importAssetsInBatches` run's own summary shape into `run` — the real-run half
 *  of asset reporting, so a caller of `applyAssets` gets the exact same `ImportRunSummary` shape a
 *  `validateAssets` dry run would have populated for the same records. */
export function mergeAssetBatchSummary(
  run: ImportRunSummary,
  batch: AssetBatchImportSummary
): void {
  run.assets.imported += batch.written + batch.alreadyImported

  for (const fallback of batch.authorFallbacks) {
    run.items.push({
      category: 'asset',
      sourceId: fallback.sourceId,
      path: fallback.fileName,
      severity: 'warning',
      reason: `authorId ${fallback.sourceAuthorId ?? '(none)'} did not resolve to an imported user; substituted the system admin user`
    })
  }

  for (const oversize of batch.skippedOversize) {
    run.assets.skipped++
    run.items.push({
      category: 'asset',
      sourceId: oversize.sourceId,
      path: oversize.fileName,
      severity: 'warning',
      reason: oversize.reason
    })
  }

  for (const failedBatch of batch.failedBatches) {
    for (const sourceId of failedBatch.sourceIds) {
      run.assets.failed++
      run.items.push({
        category: 'asset',
        sourceId,
        path: null,
        severity: 'error',
        reason: `batch ${failedBatch.batchIndex} failed and was rolled back: ${failedBatch.error}`
      })
    }
  }
}

/**
 * Wraps `records` to also record each one's own `fileSize`, keyed by `sourceId`, into `sink` — never
 * its bytes, just the number already on the record — so `applyAssets` can compute `byteTotal` for
 * whatever actually got written after the fact, without buffering the run's actual asset data a second
 * time alongside `importAssetsInBatches`'s own batching.
 */
async function* trackFileSizes(
  records: AsyncIterable<SourceAssetRecord> | Iterable<SourceAssetRecord>,
  sink: Map<string, number>
): AsyncGenerator<SourceAssetRecord> {
  for await (const record of records) {
    sink.set(record.sourceId, record.fileSize)
    yield record
  }
}

/**
 * Real-run counterpart to `validateAssets`: runs `importAssetsInBatches` and folds its result into
 * `run` via `mergeAssetBatchSummary`, so a caller gets the same `ImportRunSummary` shape as a dry run
 * would for identical input. Returns the underlying `AssetBatchImportSummary` too, for a caller that
 * wants the fuller batch-level detail (e.g. retrying `failedBatches`) alongside the unified summary.
 */
export async function applyAssets(
  records: AsyncIterable<SourceAssetRecord> | Iterable<SourceAssetRecord>,
  systemIds: SystemIds,
  run: ImportRunSummary,
  options: AssetBatchOptions = {}
): Promise<AssetBatchImportSummary> {
  const fileSizeBySourceId = new Map<string, number>()
  const batch = createAssetBatchImportSummary()
  await importAssetsInBatches(
    trackFileSizes(records, fileSizeBySourceId),
    systemIds,
    batch,
    options
  )
  mergeAssetBatchSummary(run, batch)

  const skippedIds = new Set(batch.skippedOversize.map((s) => s.sourceId))
  const failedIds = new Set(batch.failedBatches.flatMap((b) => b.sourceIds))
  for (const [sourceId, fileSize] of fileSizeBySourceId) {
    if (!skippedIds.has(sourceId) && !failedIds.has(sourceId)) {
      run.assets.byteTotal += fileSize
    }
  }

  return batch
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

/** Everything both `validateCommentRecord` and `applyComments`'s staging hook need to turn one
 *  comment's resolved-reference state into the shared item-detail shape — kept as one function so the
 *  two modes can never phrase the same condition two different ways. */
function commentReferenceItems(
  sourceIdStr: string,
  itemPath: string | null,
  contentIsValid: boolean,
  pageUnresolved: boolean,
  sourcePageId: number | null,
  authorUnresolved: boolean,
  sourceAuthorId: number | null
): { items: ImportItemDetail[]; hasError: boolean } {
  const items: ImportItemDetail[] = []
  let hasError = false

  if (!contentIsValid) {
    hasError = true
    items.push({
      category: 'comment',
      sourceId: sourceIdStr,
      path: itemPath,
      severity: 'error',
      reason: 'comment content is not a string and cannot be staged'
    })
  }

  if (pageUnresolved) {
    items.push({
      category: 'comment',
      sourceId: sourceIdStr,
      path: itemPath,
      severity: 'warning',
      reason:
        sourcePageId === null
          ? 'comment carries no source pageId; will be staged as orphaned'
          : `pageId ${sourcePageId} did not resolve to an imported page; will be staged as orphaned`
    })
  }

  if (authorUnresolved) {
    items.push({
      category: 'comment',
      sourceId: sourceIdStr,
      path: itemPath,
      severity: 'warning',
      reason: `authorId ${sourceAuthorId} did not resolve to an imported user; will be staged as a guest comment`
    })
  }

  return { items, hasError }
}

function commentItemPath(record: SourceCommentRecord): string | null {
  return record.pageId !== null ? `page:${record.pageId}` : null
}

/**
 * Validate one 2.x comment row without writing anything — the dry-run counterpart to `stageComment`.
 * Runs the exact same `pageIdMap`/`userIdMap` resolution `stageComment` performs, but only to check
 * whether the reference is a "legitimately orphaned/guest case" (a warning — `stageComment` stages it
 * regardless) rather than a hard failure. The only hard failure this checks for is structural: content
 * that isn't a string, since that is the one thing that would actually be wrong to stage.
 */
export function validateCommentRecord(
  record: SourceCommentRecord,
  pageIdMap: PageIdMap,
  userIdMap: UserIdMap,
  run: ImportRunSummary
): void {
  const sourceIdStr = String(record.id)
  const itemPath = commentItemPath(record)

  const resolvedPageId = record.pageId === null ? undefined : pageIdMap.get(record.pageId)
  const authorUnresolved = record.authorId !== null && userIdMap.get(record.authorId) === undefined

  const { items, hasError } = commentReferenceItems(
    sourceIdStr,
    itemPath,
    typeof record.content === 'string',
    resolvedPageId === undefined,
    record.pageId,
    authorUnresolved,
    record.authorId
  )
  run.items.push(...items)

  if (hasError) {
    run.comments.failed++
  } else {
    run.comments.imported++
  }
}

/** Dry-run validate a whole stream of 2.x comment rows into `run` — the counterpart to
 *  `writeCommentsStagingBundle`. */
export async function validateComments(
  records: Iterable<SourceCommentRecord> | AsyncIterable<SourceCommentRecord>,
  pageIdMap: PageIdMap,
  userIdMap: UserIdMap,
  run: ImportRunSummary
): Promise<void> {
  for await (const record of records) {
    validateCommentRecord(record, pageIdMap, userIdMap, run)
  }
}

/**
 * Real-run counterpart to `validateComments`: stages every comment via `writeCommentsStagingBundle`
 * (the only "write" comments have on this branch — see that module's own note on why there is no
 * comments-table insert here yet) while folding the exact same per-item detail `validateCommentRecord`
 * would have produced into `run`, via `writeCommentsStagingBundle`'s `onStaged` hook. Returns the
 * manifest `writeCommentsStagingBundle` itself returns, for a caller that wants it directly.
 */
export async function applyComments(
  bundleDir: string,
  siteId: string,
  records: Iterable<SourceCommentRecord> | AsyncIterable<SourceCommentRecord>,
  pageIdMap: PageIdMap,
  userIdMap: UserIdMap,
  run: ImportRunSummary
): Promise<CommentsStagingManifest> {
  return writeCommentsStagingBundle(
    bundleDir,
    siteId,
    records,
    pageIdMap,
    userIdMap,
    (staged: StagedComment, source: SourceCommentRecord) => {
      const sourceIdStr = String(source.id)
      const itemPath = commentItemPath(source)

      const { items, hasError } = commentReferenceItems(
        sourceIdStr,
        itemPath,
        typeof source.content === 'string',
        staged.unresolvedPageId,
        source.pageId,
        source.authorId !== null && staged.authorId === null,
        source.authorId
      )
      run.items.push(...items)

      if (hasError) {
        run.comments.failed++
      } else {
        run.comments.imported++
      }
    }
  )
}
