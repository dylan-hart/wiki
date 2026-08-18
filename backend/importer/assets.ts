import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'
import { eq } from 'drizzle-orm'
import mime from 'mime'
import type { WikiDbOrTx } from '../core/db.ts'
import { assets as assetsTable, tree as treeTable } from '../db/schema.ts'
import { CustomError, decodeTreePath } from '../helpers/common.ts'
import { makeImageThumbnail } from '../helpers/images.ts'
import { kindOf, sanitizeFileName, type Asset } from '../models/assets.ts'
import type { SystemIds } from '../models/types.ts'

/** How large the file manager renders a preview — matches `models/assets.ts`'s own `upload()`. */
const THUMBNAIL_SIZE = { width: 320, height: 200 }

/**
 * One normalized source-asset record, as handed to this writer once the earlier steps of the 418
 * pipeline have already done their part: the 412 connector's own row, with a 2.x `assetFolders`
 * parent chain resolved into a slash-separated `folderPath` and a 2.x `authorId` remapped through the
 * user id-table task 414 built while importing users.
 *
 * Deliberately thinner than the 2.x `assets` row it comes from — see
 * `docs/migration/2.5x-to-3.0-mapping.md`'s `assets` section:
 * - `id` has no destination here as *the literal value to carry over* — a 2.x id is an integer and a
 *   3.0 one a UUID — but it is not thrown away either: `writeImportedAsset` derives the 3.0 id
 *   deterministically from `(siteId, sourceId)` (see `deterministicAssetId`) rather than minting a
 *   random one, exactly so that writing the same source asset twice — a batch retried after a
 *   sibling batch failed, an operator re-running the whole import — lands on the same row instead of
 *   a duplicate. `hash` is still computed fresh from the resolved path, exactly as
 *   `WIKI.models.tree.addAsset` already does for an upload.
 * - `kind` and `mime` are read off the source but never trusted as-is — see `resolveKindAndMime`.
 * - `fileSize` is asserted to already be in bytes: the mapping doc flags 2.x's column as
 *   KB-denominated, so converting it (×1024) is the connector/normalization step's job, not this
 *   writer's — a record reaching this function is expected to already be in 3.0's unit.
 */
export interface SourceAssetRecord {
  /** The source connector's own stable identifier for this asset (the 2.x `assets.id`, stringified).
   *  Never written anywhere in 3.0 — its only job is feeding `deterministicAssetId` so a re-import of
   *  the same source row is recognized as the same asset rather than duplicated. */
  sourceId: string
  filename: string
  /** The 2.x `ext` column. Normalized (leading dot stripped, lowercased) but otherwise trusted — only
   *  `kind`/`mime` are recomputed, per the task this module implements. */
  ext: string
  /** The 2.x `mime` column. Consulted only as a fallback when the file name's own extension does not
   *  resolve to a MIME type — see `resolveKindAndMime`. */
  mime: string | null
  /** Already normalized to bytes (see the class doc above). */
  fileSize: number
  /** Full bytes, or a stream to read them from. Either way this writer buffers the whole file before
   *  writing either row: `assets.data` is one `bytea` value, not a stream target. */
  data: Buffer | Readable
  /** Slash-separated, already resolved from the 2.x `assetFolders` parent chain. Empty at the site
   *  root. */
  folderPath: string
  /** The 3.0 user UUID task 414 imported this author as, or null when the source row carried none
   *  (or task 414 has not run for this source yet). Either way, an id that does not resolve to an
   *  already-imported user falls back to `SystemIds.userAdminId` — see `writeImportedAsset`. */
  authorId: string | null
  siteId: string
  createdAt: Date
  updatedAt: Date
}

/**
 * One asset import call's contribution to the run's summary — accumulated across every asset a batch
 * writes by passing the same object to each `writeImportedAsset` call.
 */
export interface AssetImportSummary {
  /** How many assets this summary has recorded a fresh write for. Does not count an asset
   *  `writeImportedAsset` found already present by its deterministic id — see `alreadyImported`. */
  written: number
  /** One entry per asset whose `authorId` did not resolve to an already-imported user and was
   *  substituted with `SystemIds.userAdminId` instead of failing the item. */
  authorFallbacks: Array<{ assetId: string; fileName: string; sourceAuthorId: string | null }>
  /** How many `writeImportedAsset` calls found their asset already written — by `deterministicAssetId`
   *  — and returned it as-is rather than writing again. The expected, healthy outcome for every item
   *  in an already-committed batch when a run is retried after a later batch's failure; see
   *  `importer/assetBatch.ts`. */
  alreadyImported: number
  /** One entry per asset skipped for exceeding the caller's `maxFileSizeBytes` ceiling, without ever
   *  reading its bytes. Populated by `importer/assetBatch.ts`'s batch runner, not by
   *  `writeImportedAsset` itself — kept on this shared summary type rather than a separate one so a
   *  caller only has to look in one place for everything that happened to a run's assets. */
  skippedOversize: Array<{
    sourceId: string
    fileName: string
    siteId: string
    fileSize: number
    reason: string
  }>
}

/** A fresh, empty summary to accumulate into across a batch of `writeImportedAsset` calls. */
export function createAssetImportSummary(): AssetImportSummary {
  return { written: 0, authorFallbacks: [], alreadyImported: 0, skippedOversize: [] }
}

/**
 * Derive this asset's 3.0 id deterministically from where it came from, rather than minting a random
 * one — see `SourceAssetRecord`'s own doc comment for why. Namespaced by `siteId` (two sites could
 * otherwise import from sources that happen to share a `sourceId`) and by the literal string `asset`
 * (so this can never collide with a different entity kind — e.g. a future importer for pages or
 * comments — reusing the same source id under the same site).
 *
 * Not a byte-for-byte RFC 4122 UUID (no version/variant nibble is forced) — Postgres's `uuid` column
 * only validates the hex-and-hyphen shape, and this only ever needs to be stable and collision-free,
 * not spec-compliant.
 */
export function deterministicAssetId(siteId: string, sourceId: string): string {
  const digest = createHash('sha256').update(`asset:${siteId}:${sourceId}`).digest('hex')
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`
}

/** Read a stream fully into one buffer. Only ever holds one asset's bytes at a time. */
async function bufferOf(data: Buffer | Readable): Promise<Buffer> {
  if (Buffer.isBuffer(data)) {
    return data
  }
  const chunks: Buffer[] = []
  for await (const chunk of data) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/**
 * What a live upload does — `mime.getType(fileName) ?? <fallback> ?? 'application/octet-stream'`,
 * then `kindOf(mimeType, fileExt)` — applied here against the source's own `mime` column as the
 * fallback instead of a request header, so an import lands on the same values a fresh upload of the
 * same file would.
 */
function resolveKindAndMime(fileName: string, fileExt: string, sourceMime: string | null) {
  const mimeType = mime.getType(fileName) ?? sourceMime ?? 'application/octet-stream'
  return { mimeType, kind: kindOf(mimeType, fileExt) }
}

export interface WriteImportedAssetOptions {
  /** Overridable for tests. Defaults to the real, Sharp-backed `makeImageThumbnail`. */
  makeThumbnail?: (data: Buffer, width: number, height: number) => Promise<Buffer | null>
  /** Runs every write in this call — and the existence check that guards it — against this instead
   *  of the ambient `WIKI.db`. `importer/assetBatch.ts`'s batch runner passes its own transaction so
   *  a whole batch's writes commit, or roll back, together. */
  db?: WikiDbOrTx
}

/**
 * Write one normalized source-asset record into 3.0 as a paired `assets` + `tree` row sharing one
 * UUID — the same shape `models/assets.ts`'s `upload()`/`replace()` produce for a live upload, minus
 * the HTTP-upload-specific bits that make no sense for a batch import:
 *
 * - No conflict-behavior prompting (`UploadConflictBehavior`): `WIKI.models.tree.addAsset` still
 *   settles a same-folder name collision on its own (by suffixing), but this writer never asks the
 *   site's `uploads.conflictBehavior` setting or treats a taken name as a reason to replace anything —
 *   an import writes new rows, it never overwrites an asset already on this 3.0 instance.
 * - No `asset:upload`/`asset:edit` hook emission: those exist to tell a running instance's caches and
 *   subscribers about a change made *while it was running*; a batch import populates a database before
 *   (or independently of) anything is watching it.
 *
 * What is preserved instead of defaulted, unlike `upload()`:
 * - `createdAt`/`updatedAt` come from the source record, not `now()` — `upload()`'s default is correct
 *   for a live upload and wrong for a historical import, which must keep the moment the file actually
 *   entered the wiki.
 * - `kind`/`mimeType` are recomputed via the exact `kindOf()`/`mime` logic `upload()` uses, rather than
 *   trusted from the source's own `kind`/`mime` columns (see `resolveKindAndMime`).
 * - `preview` is regenerated via `makeImageThumbnail` for an image-kind asset, since 2.x never stored
 *   one of its own to carry over.
 * - `storageInfo` is left null: it is populated by the storage layer post-import, not by this writer.
 *
 * An `authorId` that does not resolve to a user task 414 already imported (including a null one) falls
 * back to `systemIds.userAdminId` and is recorded on `summary` rather than failing the item.
 *
 * Idempotent by construction: before writing anything (in particular, before reading a single byte of
 * `record.data`) it checks whether `deterministicAssetId(record.siteId, record.sourceId)` already
 * names an `assets` row. If it does, this call is a repeat of one that already landed — most likely
 * this same batch retried after a *different* batch in the same run failed — and it returns that row
 * as-is, recorded on `summary.alreadyImported`, rather than writing (or erroring on) a duplicate.
 */
export async function writeImportedAsset(
  record: SourceAssetRecord,
  systemIds: SystemIds,
  summary: AssetImportSummary,
  options: WriteImportedAssetOptions = {}
): Promise<Asset> {
  const db = options.db ?? WIKI.db
  const makeThumbnail = options.makeThumbnail ?? makeImageThumbnail

  const fileName = sanitizeFileName(record.filename)
  if (!fileName) {
    throw new CustomError('assetInvalidFileName', 'This file name cannot be used.')
  }
  const fileExt = record.ext.replace(/^\./, '').toLowerCase()

  const id = deterministicAssetId(record.siteId, record.sourceId)

  const existingAsset = (
    await db.select().from(assetsTable).where(eq(assetsTable.id, id)).limit(1)
  )[0]
  if (existingAsset) {
    const existingTree = (await db.select().from(treeTable).where(eq(treeTable.id, id)).limit(1))[0]
    summary.alreadyImported++
    return {
      id: existingAsset.id,
      fileName: existingAsset.fileName,
      fileExt: existingAsset.fileExt,
      kind: existingAsset.kind,
      mimeType: existingAsset.mimeType,
      fileSize: existingAsset.fileSize ?? 0,
      folderPath: decodeTreePath(existingTree?.folderPath ?? '') ?? '',
      title: existingTree?.title ?? existingAsset.fileName,
      hasPreview: Boolean(existingAsset.preview),
      createdAt: existingAsset.createdAt,
      updatedAt: existingAsset.updatedAt
    }
  }

  const data = await bufferOf(record.data)
  const { mimeType, kind } = resolveKindAndMime(fileName, fileExt, record.mime)
  const preview =
    kind === 'image' ? await makeThumbnail(data, THUMBNAIL_SIZE.width, THUMBNAIL_SIZE.height) : null

  let authorId = record.authorId
  let authorFallback = !authorId
  if (authorId && !(await WIKI.models.users.getById(authorId))) {
    authorFallback = true
  }
  if (authorFallback) {
    authorId = systemIds.userAdminId
  }

  // -> An asset carries no locale of its own in 2.x; the paired tree row needs one, and the site's
  //    primary locale is what the file manager itself uploads into.
  const locale = WIKI.sites[record.siteId]?.config?.locales?.primary ?? 'en'

  const entry = await WIKI.models.tree.addAsset({
    id,
    parentPath: record.folderPath,
    fileName,
    title: fileName,
    locale,
    siteId: record.siteId,
    meta: { fileSize: record.fileSize, fileExt, mimeType },
    db
  })

  try {
    await db.insert(assetsTable).values({
      id: entry.id,
      fileName: entry.fileName,
      fileExt,
      kind,
      mimeType,
      fileSize: record.fileSize,
      data,
      preview,
      authorId: authorId!,
      siteId: record.siteId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    })
  } catch (err) {
    // -> Nothing points at the tree row now, and leaving it would show a file the site cannot serve.
    //    Inside a batch transaction this is moot — the throw below rolls the whole batch back anyway
    //    — but it is what keeps a non-batched (`db` defaulted to `WIKI.db`) call clean too.
    await db.delete(treeTable).where(eq(treeTable.id, entry.id))
    throw err
  }

  // -> `addAsset` stamped both timestamps with `now()`; this is a historical import, not a fresh
  //    write, so the tree row is corrected to match the asset row it was written with.
  await db
    .update(treeTable)
    .set({ createdAt: record.createdAt, updatedAt: record.updatedAt })
    .where(eq(treeTable.id, entry.id))

  if (authorFallback) {
    summary.authorFallbacks.push({
      assetId: entry.id,
      fileName: entry.fileName,
      sourceAuthorId: record.authorId
    })
  }
  summary.written++

  return {
    id: entry.id,
    fileName: entry.fileName,
    fileExt,
    kind,
    mimeType,
    fileSize: record.fileSize,
    folderPath: decodeTreePath(entry.folderPath ?? '') ?? '',
    title: entry.title,
    hasPreview: Boolean(preview),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  }
}
