import fs from 'node:fs/promises'
import path from 'node:path'
import mime from 'mime'
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { assets as assetsTable, tree as treeTable } from '../db/schema.ts'
import { CustomError, decodeTreePath, encodeTreePath } from '../helpers/common.ts'
import { makeImageThumbnail, sanitizeSvg, svgMimeType } from '../helpers/images.ts'
import { belongsInTarget } from '../helpers/blobTarget.ts'
import { announce } from './hooks.ts'
import { DB_MODULE } from './storage.ts'
import type { Readable } from 'node:stream'
import type { DeletedEntry } from './tree.ts'
import type { StorageTarget } from './storage.ts'

/** How large the file manager renders a preview. Generated once, at upload time. */
const THUMBNAIL_SIZE = { width: 320, height: 200 }

/**
 * How long a path resolution is trusted before it is looked up again.
 *
 * The backstop rather than the mechanism: the mutations that move an asset drop the entries they
 * affect, but only on the instance that ran them, and a second instance has no way to hear about it —
 * so every entry expires on its own as well. Short enough that a rename made elsewhere shows up
 * quickly, long enough that a busy page's images resolve once rather than once per request.
 */
const PATH_CACHE_TTL_MS = 60_000

/** How many path resolutions to hold per instance. Each is one row of metadata, so this is small. */
const PATH_CACHE_MAX = 5000

/** Ceiling for the disk cache when nothing is configured. */
const DEFAULT_CACHE_MAX_SIZE = 512 * 1024 * 1024

/** Sweep once this much of the ceiling has been written since the last one. */
const SWEEP_TRIGGER_RATIO = 0.25

/** How far under the ceiling a sweep trims, so that the next write does not trigger another. */
const SWEEP_TARGET_RATIO = 0.8

/**
 * Extensions a browser may render inline. Everything else is sent as a download.
 *
 * Read by both routes that hand out an asset's bytes — the API's `/content` and the public
 * `/_files/` path — which have to agree on what a browser is allowed to open in place.
 */
export const INLINE_EXTS = new Set(['png', 'apng', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'])

/**
 * Whether a served asset should be sent as `Content-Disposition: attachment` rather than inline.
 *
 * The single predicate both byte-serving routes call (`controllers/files.ts` and `api/assets.ts`'s
 * `/content`), replacing two expressions that used to disagree — and, on this exact question, were
 * inverted (OpenProject #1360/#2152/#2164, 2026-08-24 security audit §3): an `INLINE_EXTS` member is
 * never forced to download, whatever `forceAssetDownload` says — that flag only ever adds attachment
 * framing to what would otherwise be sent as a plain download already. Adopting the API route's old,
 * stricter `forceAssetDownload || !INLINE_EXTS.has(fileExt)` everywhere instead would break every
 * inline image in every page's content the moment an operator turned the setting on, which is why
 * `controllers/files.ts` was written the other way to begin with. This is intentionally *not* the
 * durable defence for the SVG/HTML case (an asset can still take the inline branch): that is
 * `helpers/security.ts#needsSvgCsp` and its per-response Content-Security-Policy, applied
 * unconditionally regardless of what this function returns. This predicate is disposition-only, and
 * its role here is defence in depth for every other extension.
 */
export function dispositionFor(fileExt: string): boolean {
  return !INLINE_EXTS.has(fileExt) && Boolean(WIKI.config.security?.forceAssetDownload)
}

/** What an asset is, for the sake of grouping and filtering. Mirrors the `assetKind` schema enum. */
export type AssetKind = 'document' | 'image' | 'other'

/**
 * What an upload does about a file already sitting at the name it wants, per the site's
 * `uploads.conflictBehavior` setting.
 *
 * - `overwrite` replaces the file where it is: same ID, same path, so every page pointing at it now
 *   shows the new contents. This is the default, and the one that makes re-uploading a corrected file
 *   do what the uploader meant.
 * - `reject` refuses the upload and says what is in the way, for a wiki where a file's contents are
 *   expected to be stable once published.
 * - `new` keeps both, the arrival taking the next free `name-1.ext`.
 *
 * Whichever is chosen, only an *asset* can be replaced: a page or a folder already holding the name
 * is reported rather than written over.
 */
export type UploadConflictBehavior = 'overwrite' | 'reject' | 'new'

const UPLOAD_CONFLICT_BEHAVIORS = new Set<UploadConflictBehavior>(['overwrite', 'reject', 'new'])

/** Extensions that count as a document rather than "other". */
const DOCUMENT_EXTS = new Set([
  'csv',
  'doc',
  'docx',
  'epub',
  'md',
  'odp',
  'ods',
  'odt',
  'pdf',
  'ppt',
  'pptx',
  'rtf',
  'txt',
  'xls',
  'xlsx'
])

/** An asset's metadata, as exposed by the API. */
export interface Asset {
  id: string
  fileName: string
  fileExt: string
  kind: AssetKind
  mimeType: string
  fileSize: number
  /** Slash-separated, without a leading or trailing slash. Empty at the site root. */
  folderPath: string
  title: string
  hasPreview: boolean
  createdAt: Date
  updatedAt: Date
  /**
   * Which locale's tree the asset sits in. Carried on every asset because a path lookup has to say
   * which one it landed on: the URL in a page carries no locale, and the permission rules may be
   * written against one.
   */
  locale: string
}

/**
 * The twelve columns an {@link Asset} is read from, joined across `assets` and its `tree` row (the
 * two share an id). Both reads that answer with a whole `Asset` — by id and by path — select exactly
 * these, so they cannot drift apart the day a field is added to one.
 */
const assetSelection = {
  id: assetsTable.id,
  fileName: assetsTable.fileName,
  fileExt: assetsTable.fileExt,
  kind: assetsTable.kind,
  mimeType: assetsTable.mimeType,
  fileSize: assetsTable.fileSize,
  createdAt: assetsTable.createdAt,
  updatedAt: assetsTable.updatedAt,
  folderPath: treeTable.folderPath,
  title: treeTable.title,
  locale: treeTable.locale,
  // -> Only whether there is one: the preview itself can be megabytes, and no caller of this wants it
  //    inlined
  hasPreview: sql<boolean>`${assetsTable.preview} IS NOT NULL`
}

/**
 * The three fix-ups an {@link assetSelection} row needs to be an {@link Asset}: a nullable `fileSize`
 * read as 0, the ltree `folderPath` decoded back to slashes, and `hasPreview` as a real boolean.
 */
function toAsset(row: Record<string, any>): Asset {
  return {
    ...row,
    fileSize: row.fileSize ?? 0,
    folderPath: decodeTreePath(row.folderPath ?? '') ?? '',
    hasPreview: Boolean(row.hasPreview)
  } as Asset
}

/**
 * What `/_thumb/` needs to decide whether the requester may see an asset's preview, plus the bytes
 * themselves: which site it belongs to, and the path/locale a page-rule check is written against.
 */
export interface AssetThumbnail {
  siteId: string
  folderPath: string
  fileName: string
  locale: string
  preview: Buffer
}

/**
 * Reduce whatever a client called the file to something safe to store, address and serve.
 *
 * Any directory part is dropped — the folder comes from the request, never from the name — and what
 * is left is lowercased down to the characters that survive a URL untouched, which is the same bar
 * folder path names are held to.
 *
 * Applied to every upload, with nothing to turn it off: a stored name is a URL, and a path is looked
 * up lowercased, so a name that skipped this would be one the site could not serve back.
 */
function sanitizeFileName(input: string): string {
  const base = path.basename(input.trim().replaceAll('\\', '/'))
  const cleaned = base
    .toLowerCase()
    .replaceAll(/\s+/g, '-')
    .replaceAll(/[^a-z0-9._-]/g, '')
    // -> A leading dot would make it a hidden file, and a run of them can walk out of the folder
    .replace(/^\.+/, '')
    .replaceAll(/\.{2,}/g, '.')
  return cleaned.slice(0, 255)
}

/**
 * The form a file path is cached under.
 *
 * Matches what the lookup does with it — empty segments dropped, lowercased — so that the spellings
 * of a path that reach the same asset share one cache entry instead of each getting their own.
 */
function normalizePath(filePath: string): string {
  return filePath.split('/').filter(Boolean).join('/').toLowerCase()
}

/**
 * The extension, lowercase and without its dot. Empty when the name has none.
 */
function extensionOf(fileName: string): string {
  return path.extname(fileName).replace(/^\./, '').toLowerCase()
}

/**
 * Classifies an asset as `image`, `document` or `other` from its resolved MIME type and extension.
 */
function kindOf(mimeType: string, fileExt: string): AssetKind {
  if (mimeType.startsWith('image/')) {
    return 'image'
  }
  if (
    mimeType === 'application/pdf' ||
    mimeType.startsWith('text/') ||
    DOCUMENT_EXTS.has(fileExt)
  ) {
    return 'document'
  }
  return 'other'
}

/**
 * Assets model
 *
 * An asset is a file a user uploaded: its bytes live in the `assets` table, while its name and place
 * in the site live in the matching `tree` row, which shares its ID. Both are written together — an
 * asset with no tree row would be unreachable, and a tree row with no asset would be a broken link.
 *
 * The database is always the one durable copy, whatever else is also configured (a blob target such
 * as `s3` mirrors bytes via `dispatchStorage` rather than being read from directly for a normal
 * request — see `governingTarget()`) — but not the one that answers a request for a file. Serving
 * goes through two caches, because `/_files/` is hit by every image on every page view and neither
 * half of that lookup needs the database twice:
 *
 * 1. **memory**, holding path → metadata for `PATH_CACHE_TTL_MS`, which is what decides the ETag and
 *    answers the conditional requests a browser sends once its own copy goes stale
 * 2. **disk**, under `<dataPath>/cache/files`, holding the bytes, streamed straight to the response
 *
 * Only the database is permanent; both caches are derived and can be deleted at any point, which is
 * also what makes a cold instance correct rather than empty-handed.
 */
class Assets {
  /** Path resolutions, keyed `siteId:path`. Insertion-ordered, so the oldest entry is evictable. */
  pathCache = new Map<string, { asset: Asset; cachedAt: number }>()

  /** Bytes written to the disk cache since the last sweep, for `SWEEP_TRIGGER_RATIO`. */
  writtenSinceSweep = 0

  /** Whether a sweep is running, so that a burst of writes queues no more than one. */
  sweeping = false

  /**
   * What this site does about an upload landing on a name that is taken.
   *
   * Read per upload rather than held anywhere, so that changing it in the admin area applies to the
   * next file rather than to the next restart. Anything unrecognized is treated as the default.
   */
  conflictBehaviorFor(siteId: string): UploadConflictBehavior {
    const configured = WIKI.sites[siteId]?.config?.uploads?.conflictBehavior
    return UPLOAD_CONFLICT_BEHAVIORS.has(configured) ? configured : 'overwrite'
  }

  /**
   * Store an uploaded file.
   *
   * A file already at this name is settled per the site's conflict behavior — see
   * `UploadConflictBehavior`. An overwrite returns the existing asset's ID, so a caller that means to
   * link to what it just uploaded must read the returned name and ID rather than assume its own.
   *
   * @param folderId UUID of the folder to upload into. The site root when absent.
   * @param fileName What to call it. Sanitized, so what comes back may differ from what went in.
   * @param data The file itself.
   */
  async upload({
    siteId,
    locale,
    folderId,
    fileName,
    mimeType,
    data,
    authorId
  }: {
    siteId: string
    locale: string
    folderId?: string | null
    fileName: string
    mimeType?: string | null
    data: Buffer
    authorId: string
  }): Promise<Asset> {
    const safeName = sanitizeFileName(fileName)
    if (!safeName) {
      throw new CustomError('assetInvalidFileName', 'This file name cannot be used.')
    }
    const fileExt = extensionOf(safeName)
    // -> The extension decides the type, not the request: the declared one is whatever the client felt
    //    like sending, and this value is what gets served back to a browser later
    const resolvedMime = mime.getType(safeName) ?? mimeType ?? 'application/octet-stream'
    const kind = kindOf(resolvedMime, fileExt)
    // -> Only reached when the flag is on: a disabled `security.uploadScanSVG` stores the bytes
    //    exactly as uploaded, same as before this existed.
    const fileData =
      resolvedMime === svgMimeType && WIKI.config.security?.uploadScanSVG ? sanitizeSvg(data) : data

    const preview =
      kind === 'image'
        ? await makeImageThumbnail(fileData, THUMBNAIL_SIZE.width, THUMBNAIL_SIZE.height)
        : null

    // -> What is already at this name, if anything, and what the site says to do about it. Asked
    //    before any row is touched, since two of the three answers write nothing new at all.
    const behavior = this.conflictBehaviorFor(siteId)
    const occupant =
      behavior === 'new'
        ? null
        : await WIKI.models.tree.getEntryAt({
            siteId,
            locale,
            parentId: folderId,
            fileName: safeName
          })
    if (occupant) {
      if (occupant.type !== 'asset') {
        // -> Neither replacing nor renaming is what an administrator asked for here: a page or a
        //    folder owns this name, and only its owner can give it up
        throw new CustomError(
          'assetNameTakenByEntry',
          `A ${occupant.type} with this name already exists here.`,
          409
        )
      }
      if (behavior === 'reject') {
        throw new CustomError(
          'assetAlreadyExists',
          'A file with this name already exists here.',
          409
        )
      }
      return this.replace({
        id: occupant.id,
        siteId,
        locale,
        folderPath: decodeTreePath(occupant.folderPath ?? '') ?? '',
        fileName: occupant.fileName,
        title: occupant.title,
        fileExt,
        kind,
        mimeType: resolvedMime,
        data: fileData,
        preview,
        authorId
      })
    }

    // -> The tree row goes in first: it owns the name, and it is what settles a collision with
    //    something already in the folder before any bytes are written. What comes back is the name
    //    that was actually free, which is not always the one asked for.
    const entry = await WIKI.models.tree.addAsset({
      parentId: folderId,
      fileName: safeName,
      title: safeName,
      locale,
      siteId,
      meta: {
        fileSize: fileData.length,
        fileExt,
        mimeType: resolvedMime
      }
    })
    const storedName = entry.fileName

    try {
      await WIKI.db.insert(assetsTable).values({
        id: entry.id,
        fileName: storedName,
        fileExt,
        kind,
        mimeType: resolvedMime,
        fileSize: fileData.length,
        data: fileData,
        preview,
        authorId,
        siteId
      })
    } catch (err) {
      // -> Nothing points at the tree row now, and leaving it would show a file the site cannot serve
      await WIKI.db.delete(treeTable).where(eq(treeTable.id, entry.id))
      throw err
    }

    await announce(
      'asset:upload',
      siteId,
      {
        id: entry.id,
        fileName: storedName,
        folderPath: decodeTreePath(entry.folderPath ?? '') ?? '',
        siteId,
        authorId
      },
      {
        metadata: { fileSize: fileData.length, mimeType: resolvedMime, kind },
        dispatchExtra: { kind, fileSize: fileData.length }
      }
    )

    return {
      id: entry.id,
      fileName: storedName,
      fileExt,
      kind,
      mimeType: resolvedMime,
      fileSize: fileData.length,
      folderPath: decodeTreePath(entry.folderPath ?? '') ?? '',
      title: entry.title,
      hasPreview: Boolean(preview),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      locale
    }
  }

  /**
   * Replace an existing asset's contents in place, for an upload that landed on it under the
   * `overwrite` conflict behavior.
   *
   * The asset keeps its ID, its name and its place in the tree, so every page and every link already
   * pointing at the file goes on working and now resolves to the new bytes. What changes is what the
   * file *is* — its contents, size, type and thumbnail — plus who put them there.
   *
   * The name it keeps is the stored one, which is why the extension and type are the incoming file's:
   * the two only differ when a browser sent `Photo.PNG` for what is stored as `photo.png`, and the
   * sanitized name is what both agree on.
   */
  private async replace({
    id,
    siteId,
    locale,
    folderPath,
    fileName,
    title,
    fileExt,
    kind,
    mimeType,
    data,
    preview,
    authorId
  }: {
    id: string
    siteId: string
    locale: string
    folderPath: string
    fileName: string
    title: string
    fileExt: string
    kind: AssetKind
    mimeType: string
    data: Buffer
    preview: Buffer | null
    authorId: string
  }): Promise<Asset> {
    await WIKI.db
      .update(assetsTable)
      .set({
        fileExt,
        kind,
        mimeType,
        fileSize: data.length,
        data,
        preview,
        authorId,
        updatedAt: sql`now()`
      })
      .where(eq(assetsTable.id, id))
    // -> The tree carries its own copy of these, and it is what a folder listing reads
    await WIKI.db
      .update(treeTable)
      .set({ meta: { fileSize: data.length, fileExt, mimeType }, updatedAt: sql`now()` })
      .where(eq(treeTable.id, id))

    // -> The path resolves to the same asset as before, but to different metadata: the ETag is the
    //    modification time, so a reader holding the old file has to be told to fetch it again. The
    //    cached bytes are keyed by that same time and are unreachable from here on, but are dropped
    //    rather than left for the sweep, since the file they hold is gone for good.
    this.forgetPath(siteId, folderPath, fileName)
    await this.dropCachedContent([id])

    await announce(
      'asset:edit',
      siteId,
      { id, fileName, folderPath, siteId, authorId },
      {
        metadata: { fileSize: data.length, mimeType, kind },
        dispatchExtra: { kind, fileSize: data.length }
      }
    )

    const updated = await this.getAsset(siteId, id)
    // -> Only if the row vanished between the update and the read, which means someone deleted the
    //    file mid-upload. Answering with what was written beats failing a request that did land.
    return (
      updated ?? {
        id,
        fileName,
        fileExt,
        kind,
        mimeType,
        fileSize: data.length,
        folderPath,
        title,
        hasPreview: Boolean(preview),
        locale,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    )
  }

  /**
   * An asset's metadata, without its bytes. Null if there is no such asset on this site.
   */
  async getAsset(siteId: string, id: string): Promise<Asset | null> {
    const results = await WIKI.db
      .select(assetSelection)
      .from(assetsTable)
      .innerJoin(treeTable, eq(treeTable.id, assetsTable.id))
      .where(and(eq(assetsTable.id, id), eq(assetsTable.siteId, siteId)))
      .limit(1)

    const row = results[0]
    return row ? toAsset(row) : null
  }

  /**
   * Every asset of a site, metadata only — no bytes, no pagination.
   *
   * For a full walk of a site's assets (a file-backed storage target reconciling its repo against the
   * DB, chiefly). A caller that needs an asset's bytes fetches them per asset via `getContent()`, the
   * same way `modules/storage/git/content.ts`'s write-path handlers already do.
   */
  async listAllForSite(
    siteId: string
  ): Promise<
    { id: string; kind: AssetKind; folderPath: string; fileName: string; fileSize: number }[]
  > {
    const rows = await WIKI.db
      .select({
        id: assetsTable.id,
        kind: assetsTable.kind,
        folderPath: treeTable.folderPath,
        fileName: assetsTable.fileName,
        fileSize: assetsTable.fileSize
      })
      .from(assetsTable)
      .innerJoin(treeTable, eq(treeTable.id, assetsTable.id))
      .where(eq(assetsTable.siteId, siteId))
    return rows.map((row) => ({
      ...row,
      fileSize: row.fileSize ?? 0,
      folderPath: decodeTreePath(row.folderPath ?? '') ?? ''
    }))
  }

  /**
   * An asset's metadata, addressed the way a page's content addresses it: by its path within the
   * site. Null if there is nothing there.
   *
   * The path lives on the tree row rather than on the asset — the two share an ID — so the lookup
   * splits it into the folder and the file the way the tree stores them, the folder as an ltree.
   * Both are lowercased, because that is what an upload stored them as.
   *
   * A path can exist once per locale and the URL carries none, so the site's primary locale wins
   * where more than one has a file there. That is also the only one the file manager uploads into.
   */
  async getAssetByPath(siteId: string, filePath: string): Promise<Asset | null> {
    const segments = filePath.split('/').filter(Boolean)
    const fileName = segments.pop()?.toLowerCase()
    if (!fileName) {
      return null
    }
    const primaryLocale = WIKI.sites[siteId]?.config?.locales?.primary ?? 'en'

    const results = await WIKI.db
      .select(assetSelection)
      .from(assetsTable)
      .innerJoin(treeTable, eq(treeTable.id, assetsTable.id))
      .where(
        and(
          eq(assetsTable.siteId, siteId),
          eq(treeTable.type, 'asset'),
          eq(treeTable.folderPath, encodeTreePath(segments.join('/'))),
          eq(treeTable.fileName, fileName)
        )
      )
      .orderBy(desc(sql`${treeTable.locale} = ${primaryLocale}`))
      .limit(1)

    const row = results[0]
    return row ? toAsset(row) : null
  }

  /**
   * An asset's bytes, along with what to serve them as. Null if there is no such asset.
   *
   * Not scoped to a site, unlike the rest: the ID is a UUID nobody can guess, and the routes that use
   * this are the public ones, which have no site of their own to check against.
   */
  async getContent(
    id: string
  ): Promise<{ data: Buffer; mimeType: string; fileName: string } | null> {
    const results = await WIKI.db
      .select({
        data: assetsTable.data,
        mimeType: assetsTable.mimeType,
        fileName: assetsTable.fileName
      })
      .from(assetsTable)
      .where(eq(assetsTable.id, id))
      .limit(1)
    const row = results[0]
    return row?.data ? { data: row.data, mimeType: row.mimeType, fileName: row.fileName } : null
  }

  /**
   * Every asset of a site, bytes included — for a caller that has to write out everything it holds,
   * which today is only a blob storage target's `exportAll` (see `modules/storage/s3/storage.ts`).
   *
   * Paged by primary key rather than pulled in one query: a site's assets can run into the gigabytes
   * once bytes are included, so this keeps memory bounded to one batch rather than materializing the
   * whole site at once. `id`'s own btree index is what keeps `id > cursor` cheap to keep paging
   * against, unlike an `OFFSET` that re-scans everything before it on every page.
   */
  async *streamAll(
    siteId: string,
    batchSize = 100
  ): AsyncGenerator<{
    id: string
    fileName: string
    folderPath: string
    kind: AssetKind
    fileSize: number
    mimeType: string
    data: Buffer
  }> {
    let cursor: string | null = null
    for (;;) {
      const rows = await WIKI.db
        .select({
          id: assetsTable.id,
          fileName: assetsTable.fileName,
          kind: assetsTable.kind,
          fileSize: assetsTable.fileSize,
          mimeType: assetsTable.mimeType,
          data: assetsTable.data,
          folderPath: treeTable.folderPath
        })
        .from(assetsTable)
        .innerJoin(treeTable, eq(treeTable.id, assetsTable.id))
        .where(and(eq(assetsTable.siteId, siteId), cursor ? gt(assetsTable.id, cursor) : undefined))
        .orderBy(assetsTable.id)
        .limit(batchSize)

      for (const row of rows) {
        // -> An asset row can exist with no bytes yet (e.g. mid-upload); nothing to export for it
        if (!row.data) {
          continue
        }
        yield {
          id: row.id,
          fileName: row.fileName,
          folderPath: decodeTreePath(row.folderPath ?? '') ?? '',
          kind: row.kind,
          fileSize: row.fileSize ?? 0,
          mimeType: row.mimeType,
          data: row.data
        }
      }

      if (rows.length < batchSize) {
        return
      }
      cursor = rows[rows.length - 1]!.id
    }
  }

  /**
   * An asset's thumbnail, together with what `/_thumb/` needs to decide who may see it — its site,
   * path and locale, the same shape `getAssetByPath()` hands `/_files/` — or null when there is no
   * such asset, or it has no thumbnail: the normal state for anything that is not an image, for
   * images uploaded while Sharp was unavailable, or for one a storage target's `purge()` has nulled
   * out.
   */
  async getThumbnail(id: string): Promise<AssetThumbnail | null> {
    const results = await WIKI.db
      .select({
        siteId: assetsTable.siteId,
        preview: assetsTable.preview,
        folderPath: treeTable.folderPath,
        fileName: treeTable.fileName,
        locale: treeTable.locale
      })
      .from(assetsTable)
      .innerJoin(treeTable, eq(treeTable.id, assetsTable.id))
      .where(eq(assetsTable.id, id))
      .limit(1)
    const row = results[0]
    if (!row?.preview) {
      return null
    }
    return {
      siteId: row.siteId,
      folderPath: decodeTreePath(row.folderPath ?? '') ?? '',
      fileName: row.fileName,
      locale: row.locale,
      preview: row.preview
    }
  }

  // == SERVING CACHE ==================

  /**
   * An asset addressed by path, answered from memory where it can be.
   *
   * What `/_files/` resolves every request through: the metadata decides whether the caller may read
   * the file and what its ETag is, both of which are needed before any bytes are worth fetching.
   */
  async resolveAssetPath(siteId: string, filePath: string): Promise<Asset | null> {
    const key = `${siteId}:${normalizePath(filePath)}`
    const cached = this.pathCache.get(key)
    if (cached && Date.now() - cached.cachedAt < PATH_CACHE_TTL_MS) {
      return cached.asset
    }

    const asset = await this.getAssetByPath(siteId, filePath)
    if (!asset) {
      // -> A path with nothing at it is not remembered as empty: a file uploaded there has no way to
      //    find the entry and clear it, and it would answer 404 for as long as the entry lived
      this.pathCache.delete(key)
      return null
    }
    if (this.pathCache.size >= PATH_CACHE_MAX) {
      const oldest = this.pathCache.keys().next().value
      if (oldest) {
        this.pathCache.delete(oldest)
      }
    }
    this.pathCache.set(key, { asset, cachedAt: Date.now() })
    return asset
  }

  /**
   * Forget what sits at a path, for a change that moved one asset
   */
  forgetPath(siteId: string, folderPath: string, fileName: string): void {
    this.pathCache.delete(
      `${siteId}:${normalizePath(folderPath ? `${folderPath}/${fileName}` : fileName)}`
    )
  }

  /**
   * Forget every path resolution, for a change that moved assets in bulk — a folder renamed or
   * deleted, where the paths that changed are no longer enumerable from what is left in the tree.
   */
  forgetAllPaths(): void {
    this.pathCache.clear()
  }

  /**
   * The target that governs how this site's assets are served.
   *
   * An asset's bytes always live in the assets table regardless of what else is configured (the disk
   * module only dumps/imports/backs up on request, and a file-backed or blob module keeps its own
   * copy in sync via `dispatchStorage` rather than being where `readContent` reads from directly) — so
   * the db target's `assetDelivery` settings are the default answer for whether to cache to disk and
   * whether to redirect.
   *
   * A blob target (`s3`/`azure`/`gcs`) that both has direct access turned on and actually holds a copy
   * of the asset being served — its `contentTypes` cover the asset's kind/size, per
   * `helpers/blobTarget.ts`'s `belongsInTarget` — governs instead: it is the one place besides the db
   * itself with a URL of its own for the file, so its `assetDelivery` settings decide whether that URL
   * gets used. Passing no `asset` (or omitting a kind a target's `contentTypes` distinguish by) skips
   * this check entirely and falls straight to the db target, same as before this existed.
   *
   * @returns Null when the site has no db target row at all, which `readContent` treats as the
   *   documented defaults (streaming on, no direct access) rather than as a hard failure
   */
  async governingTarget(
    siteId: string,
    asset?: { kind: AssetKind; fileSize: number }
  ): Promise<StorageTarget | null> {
    const targets = await WIKI.models.storage.getSiteTargets(siteId)
    if (asset) {
      const directAccessTarget = targets.find(
        (t) =>
          t.isEnabled &&
          t.assetDelivery.isDirectAccessSupported &&
          t.assetDelivery.directAccess &&
          belongsInTarget(asset, t.contentTypes)
      )
      if (directAccessTarget) {
        return directAccessTarget
      }
    }
    return targets.find((t) => t.module === DB_MODULE && t.isEnabled) ?? null
  }

  /**
   * A direct URL to serve an asset from instead of proxying it, if the governing target both allows
   * one and has a module behind it that can produce one. See `StorageModule.getDirectUrl`.
   */
  async directUrlFor(
    asset: { id: string; updatedAt: Date; fileName: string; folderPath: string },
    target: StorageTarget
  ): Promise<string | null> {
    if (!target.assetDelivery.directAccess || !target.assetDelivery.isDirectAccessSupported) {
      return null
    }
    const mod = await WIKI.models.storage.ensureModule(target.module)
    if (!mod?.getDirectUrl) {
      return null
    }
    return (await mod.getDirectUrl(asset, target)) ?? null
  }

  /**
   * An asset's bytes, ready to be sent — from the disk cache, or from the database and into it — or a
   * URL to redirect the request to instead, per the site's governing storage target.
   *
   * `assetDelivery.streaming` (on by default) decides whether the disk cache is used at all: off means
   * every request is a buffered read straight from the database, with nothing written to local disk —
   * the point of turning it off is that asset bytes never touch this instance's disk. `directAccess`
   * is checked first, since a target that can hand out its own URL should never have its bytes read at
   * all, cache or no cache.
   *
   * @returns A stream when the disk cache holds the file, the buffer when it had to be read from the
   *   database, a `redirectUrl` in place of either when the target supplied one, and null when there
   *   is no such asset, i.e. when a cached path resolution has outlived the row behind it
   */
  async readContent(
    asset: {
      id: string
      updatedAt: Date
      fileName: string
      folderPath: string
      kind: AssetKind
      fileSize: number
    },
    siteId: string
  ): Promise<{ body: Readable | Buffer; size: number } | { redirectUrl: string } | null> {
    const target = await this.governingTarget(siteId, {
      kind: asset.kind,
      fileSize: asset.fileSize
    })

    if (target) {
      const redirectUrl = await this.directUrlFor(asset, target)
      if (redirectUrl) {
        return { redirectUrl }
      }
    }

    // -> Absent a target row (should not normally happen — every site gets one, see `syncSite`) the
    //    documented default applies: streaming on, exactly today's pre-target-aware behavior
    const streaming = target?.assetDelivery.streaming ?? true

    if (streaming) {
      const cached = await this.readContentCache(asset)
      if (cached) {
        return cached
      }
    }

    const content = await this.getContent(asset.id)
    if (!content) {
      return null
    }
    if (streaming) {
      await this.writeContentCache(asset, content.data)
    }
    return { body: content.data, size: content.data.length }
  }

  /**
   * Where an asset's bytes sit in the disk cache.
   *
   * Named for the ID and the modification time together, which is what makes an entry immutable:
   * anything that changes a file changes the name it would be cached under, so a stale entry is never
   * read, only left behind for the sweep. Sharded by the first byte of the ID, to keep a wiki's worth
   * of files out of a single directory.
   */
  contentCachePath(asset: { id: string; updatedAt: Date }): string {
    return path.join(
      this.cachePath,
      asset.id.slice(0, 2),
      `${asset.id}-${asset.updatedAt.getTime()}.bin`
    )
  }

  /**
   * Open an asset's cached bytes.
   *
   * The file is opened before it is streamed rather than as it is streamed, so that a sweep removing
   * it midway through a response cannot truncate what is being sent: the handle keeps the bytes
   * readable until the stream closes it, whatever happens to the directory entry.
   *
   * @returns Null when this instance has not cached the file, which is the normal state of a fresh
   *   container and the state of every entry after a change to the file
   */
  async readContentCache(asset: {
    id: string
    updatedAt: Date
  }): Promise<{ body: Readable; size: number } | null> {
    let handle
    try {
      handle = await fs.open(this.contentCachePath(asset), 'r')
    } catch {
      return null
    }
    try {
      const { size } = await handle.stat()
      return { body: handle.createReadStream({ autoClose: true }), size }
    } catch {
      await handle.close().catch(() => {})
      return null
    }
  }

  /**
   * Write an asset's bytes to the disk cache, best effort.
   *
   * A full or read-only disk must not stop a file from being served, hence the swallowed error — the
   * database answers every request the cache cannot. The file is written under a temporary name and
   * renamed, so a concurrent reader sees either nothing or the whole thing.
   */
  async writeContentCache(asset: { id: string; updatedAt: Date }, data: Buffer): Promise<void> {
    // -> A file larger than the whole cache would be evicted by the sweep it triggers
    if (this.cacheMaxSize < 1 || data.length > this.cacheMaxSize) {
      return
    }
    const filePath = this.contentCachePath(asset)
    const tempPath = `${filePath}.${process.pid}.tmp`
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(tempPath, data)
      await fs.rename(tempPath, filePath)
    } catch (err: any) {
      WIKI.logger.warn(`Could not write ${filePath} to the file cache [ SKIPPED ]`)
      WIKI.logger.warn(err.message)
      await fs.rm(tempPath, { force: true }).catch(() => {})
      return
    }

    this.writtenSinceSweep += data.length
    if (this.writtenSinceSweep >= this.cacheMaxSize * SWEEP_TRIGGER_RATIO) {
      // -> Nothing waits on this: the request that filled the cache is not the one that should pay
      //    for measuring it
      void this.sweepCache()
    }
  }

  /**
   * Drop whatever the disk cache holds for these assets.
   *
   * Every entry an asset has, not just its current one — a file renamed twice leaves two behind, and
   * the point of this is to reclaim the space rather than to correct an answer, which the naming
   * already does.
   */
  async dropCachedContent(ids: string[]): Promise<void> {
    for (const id of ids) {
      const shard = path.join(this.cachePath, id.slice(0, 2))
      try {
        const entries = await fs.readdir(shard)
        await Promise.all(
          entries
            .filter((name) => name.startsWith(`${id}-`))
            .map((name) => fs.rm(path.join(shard, name), { force: true }))
        )
      } catch {
        // -> Nothing cached for it on this instance, which is not worth reporting
      }
    }
  }

  /**
   * Trim the disk cache back under its ceiling, oldest entry first.
   *
   * Oldest by when it was written rather than when it was last read: keeping a true LRU would mean
   * touching a file on every hit, which puts a write back on the path this cache exists to keep
   * writes off. An entry evicted while still in demand is refilled by the next request for it.
   */
  async sweepCache(): Promise<void> {
    if (this.sweeping) {
      return
    }
    this.sweeping = true
    this.writtenSinceSweep = 0
    try {
      const files: { path: string; size: number; writtenAt: number }[] = []
      let total = 0
      const entries = await fs.readdir(this.cachePath, { recursive: true, withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.bin')) {
          continue
        }
        const filePath = path.join(entry.parentPath, entry.name)
        const stat = await fs.stat(filePath).catch(() => null)
        if (!stat) {
          continue
        }
        files.push({ path: filePath, size: stat.size, writtenAt: stat.mtimeMs })
        total += stat.size
      }
      if (total <= this.cacheMaxSize) {
        return
      }

      files.sort((a, b) => a.writtenAt - b.writtenAt)
      const target = this.cacheMaxSize * SWEEP_TARGET_RATIO
      let removed = 0
      for (const file of files) {
        if (total <= target) {
          break
        }
        await fs.rm(file.path, { force: true })
        total -= file.size
        removed++
      }
      WIKI.logger.debug(`Trimmed ${removed} file(s) from the file cache [ OK ]`)
    } catch (err: any) {
      WIKI.logger.warn('Could not sweep the file cache [ SKIPPED ]')
      WIKI.logger.warn(err.message)
    } finally {
      this.sweeping = false
    }
  }

  /**
   * Drop both serving caches of this instance.
   *
   * Nothing is lost: the metadata is read back from the database on the next request for a path, and
   * the bytes on the next request for a file. What it costs is the refill — every image on the next
   * page view goes to the database once — which is the price of being certain nothing stale is being
   * served.
   */
  async purgeCache(): Promise<void> {
    this.pathCache.clear()
    this.writtenSinceSweep = 0
    await fs.rm(this.cachePath, { recursive: true, force: true })
    await fs.mkdir(this.cachePath, { recursive: true })
    WIKI.logger.info('Purged the file cache [ OK ]')
  }

  /** Where the disk cache lives. Derived data — deleting it costs a refill and nothing else. */
  get cachePath(): string {
    return path.resolve(WIKI.ROOTPATH, WIKI.config.dataPath, 'cache/files')
  }

  /** How large the disk cache may grow, in bytes. Zero turns it off. */
  get cacheMaxSize(): number {
    return WIKI.config.files?.cacheMaxSize ?? DEFAULT_CACHE_MAX_SIZE
  }

  /**
   * Rename an asset, in both of the rows that describe it.
   *
   * @returns The updated metadata, or null if there is no such asset on this site
   */
  async renameAsset(siteId: string, id: string, fileName: string): Promise<Asset | null> {
    const asset = await this.getAsset(siteId, id)
    if (!asset) {
      return null
    }
    const safeName = sanitizeFileName(fileName)
    if (!safeName) {
      throw new CustomError('assetInvalidFileName', 'This file name cannot be used.')
    }
    const fileExt = extensionOf(safeName)
    if (!fileExt) {
      throw new CustomError('assetInvalidFileName', 'The file name must keep a file extension.')
    }
    const resolvedMime = mime.getType(safeName) ?? asset.mimeType

    await WIKI.models.tree.renameEntry({ id, fileName: safeName, title: safeName })
    await WIKI.db
      .update(assetsTable)
      .set({
        fileName: safeName,
        fileExt,
        mimeType: resolvedMime,
        kind: kindOf(resolvedMime, fileExt),
        updatedAt: sql`now()`
      })
      .where(eq(assetsTable.id, id))
    // -> The tree carries its own copy of these, and it is what a folder listing reads
    await WIKI.db
      .update(treeTable)
      .set({ meta: { fileSize: asset.fileSize, fileExt, mimeType: resolvedMime } })
      .where(eq(treeTable.id, id))

    // -> Both ends of the move: the name it left, and the name it took, which something else may have
    //    been resolved at before it was freed up
    this.forgetPath(siteId, asset.folderPath, asset.fileName)
    this.forgetPath(siteId, asset.folderPath, safeName)
    await this.dropCachedContent([id])

    await announce(
      'asset:rename',
      siteId,
      {
        id,
        fileName: safeName,
        previousFileName: asset.fileName,
        folderPath: asset.folderPath,
        siteId
      },
      { dispatchExtra: { kind: asset.kind, fileSize: asset.fileSize } }
    )

    return this.getAsset(siteId, id)
  }

  /**
   * Delete an asset and the tree entry that points at it.
   *
   * @returns Whether an asset was deleted
   */
  async deleteAsset(siteId: string, id: string): Promise<boolean> {
    const asset = await this.getAsset(siteId, id)
    if (!asset) {
      return false
    }
    await WIKI.db.delete(assetsTable).where(eq(assetsTable.id, id))
    await WIKI.models.tree.deleteEntry(id)

    this.forgetPath(siteId, asset.folderPath, asset.fileName)
    await this.dropCachedContent([id])

    // -> `contentSyncState.contentId` isn't a real FK (it can point at a page or an asset), so nothing
    //    at the db level drops the sync-state rows for this asset on its own.
    await WIKI.models.contentSync.forgetContent('asset', id)

    await announce(
      'asset:delete',
      siteId,
      { id, fileName: asset.fileName, folderPath: asset.folderPath, siteId },
      { dispatchExtra: { kind: asset.kind, fileSize: asset.fileSize } }
    )

    return true
  }

  /**
   * Delete the assets left behind by a folder deletion, which removed their tree entries already.
   */
  async deleteOrphaned(siteId: string, entries: DeletedEntry[]): Promise<void> {
    if (entries.length < 1) {
      return
    }
    const ids = entries.map((entry) => entry.id)
    // -> `kind`/`fileSize` are returned rather than dropped with the rows: dispatching a delete needs
    //    them to classify the content type against a target's `contentTypes.activeTypes`, and this is
    //    the last point at which the database still has them
    const deleted = await WIKI.db
      .delete(assetsTable)
      .where(inArray(assetsTable.id, ids))
      .returning({ id: assetsTable.id, kind: assetsTable.kind, fileSize: assetsTable.fileSize })
    const deletedById = new Map(deleted.map((row) => [row.id, row]))

    // -> Which paths they sat at is no longer knowable from the tree: those rows went with the folder
    this.forgetAllPaths()
    await this.dropCachedContent(ids)

    // -> Same reasoning as `deleteAsset`: one batched call rather than one per asset.
    await WIKI.models.contentSync.forgetContentBatch('asset', ids)

    // -> One per file, as deleting them one at a time would have sent: a subscriber mirroring the
    //    wiki has to hear about each file, not about the folder it happened to sit in
    for (const entry of entries) {
      const row = deletedById.get(entry.id)
      await announce(
        'asset:delete',
        siteId,
        {
          id: entry.id,
          fileName: entry.fileName,
          folderPath: entry.folderPath,
          siteId
        },
        { dispatchExtra: { kind: row?.kind, fileSize: row?.fileSize } }
      )
    }
  }
}

export const assets = new Assets()
