import path from 'node:path'
import mime from 'mime'
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { assets as assetsTable, tree as treeTable } from '../db/schema.ts'
import { CustomError, decodeTreePath, encodeTreePath } from '../helpers/common.ts'
import { makeImageThumbnail, sanitizeSvg, svgMimeType } from '../helpers/images.ts'
import { ocrAvailable, ocrKindOf } from '../helpers/ocr.ts'
import { announce } from './hooks.ts'
import type { DeletedEntry } from './tree.ts'
import type { WikiTx } from '../core/db.ts'

const THUMBNAIL_SIZE = { width: 320, height: 200 }

/** Extensions a browser may render inline. Everything else is sent as a download. */
export const INLINE_EXTS = new Set(['png', 'apng', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'])

/**
 * Whether a served asset should be sent as `Content-Disposition: attachment` rather than inline.
 * The single predicate both byte-serving routes call (`controllers/files.ts` and `api/assets.ts`'s
 * `/content`), so the same asset answers identically on either.
 *
 * An `INLINE_EXTS` member is never forced to download, whatever `forceAssetDownload` says: the
 * stricter `forceAssetDownload || !INLINE_EXTS.has(fileExt)` would break every inline image in every
 * page's content the moment an operator turned the setting on. Disposition only — the durable
 * defence for the SVG/HTML case is `helpers/security.ts#needsSvgCsp`'s per-response CSP, applied
 * whichever branch this takes.
 */
export function dispositionFor(fileExt: string): boolean {
  return !INLINE_EXTS.has(fileExt) && Boolean(CARDINAL.config.security?.forceAssetDownload)
}

/** Mirrors the `assetKind` schema enum — keep the two in step. */
export type AssetKind = 'document' | 'image' | 'other'

/**
 * What an upload does about a file already sitting at the name it wants, per the site's
 * `uploads.conflictBehavior` setting.
 *
 * - `overwrite` (the default) replaces the file where it is: same ID, same path, so every page
 *   pointing at it shows the new contents.
 * - `reject` refuses the upload and says what is in the way.
 * - `new` keeps both, the arrival taking the next free `name-1.ext`.
 *
 * Whichever is chosen, only an *asset* can be replaced: a page or a folder already holding the name
 * is reported rather than written over.
 */
export type UploadConflictBehavior = 'overwrite' | 'reject' | 'new'

const UPLOAD_CONFLICT_BEHAVIORS = new Set<UploadConflictBehavior>(['overwrite', 'reject', 'new'])

/**
 * Who a delete is attributed to in the content lifecycle log. Optional deliberately: a caller with
 * no actor behind it (a storage sync, a maintenance script) logs `user=system` rather than failing
 * to compile, and the deletion never depended on knowing who asked for it. An actor id, never an
 * e-mail address.
 */
export interface AssetDeleteOptions {
  authorId?: string | null
}

function actorFields(authorId?: string | null): { user: string } {
  return { user: authorId || 'system' }
}

function assetPath(folderPath: string, fileName: string): string {
  return folderPath ? `${folderPath}/${fileName}` : fileName
}

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
  /** Only for an image Sharp could read, so absent where Sharp is not installed. */
  width?: number
  height?: number
  createdAt: Date
  updatedAt: Date
  /**
   * Which locale's tree the asset sits in. Carried on every asset because a path lookup has to say
   * which one it landed on: the URL in a page carries no locale, and page rules may be written
   * against one.
   */
  locale: string
}

/**
 * Joined across `assets` and its `tree` row (the two share an id). Both reads that answer with a
 * whole {@link Asset} select exactly these, so they cannot drift apart when a field is added.
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
  // -> Only whether there is one: the preview itself can be megabytes, and no caller wants it inlined
  hasPreview: sql<boolean>`${assetsTable.preview} IS NOT NULL`,
  meta: assetsTable.meta
}

function dimensionsOf(meta: unknown): { width?: number; height?: number } {
  const { width, height } = (meta ?? {}) as Record<string, unknown>
  return Number.isInteger(width) && Number.isInteger(height)
    ? { width: width as number, height: height as number }
    : {}
}

function toAsset({ meta, ...row }: Record<string, any>): Asset {
  return {
    ...row,
    ...dimensionsOf(meta),
    fileSize: row.fileSize ?? 0,
    folderPath: decodeTreePath(row.folderPath ?? '') ?? '',
    hasPreview: Boolean(row.hasPreview)
  } as Asset
}

/**
 * The preview bytes plus what `/_thumb/` needs to decide who may see them: the site, and the
 * path/locale a page-rule check is written against.
 */
export interface AssetThumbnail {
  siteId: string
  folderPath: string
  fileName: string
  locale: string
  preview: Buffer
}

/**
 * Reduce whatever a client called the file to something safe to store, address and serve. Any
 * directory part is dropped — the folder comes from the request, never from the name.
 *
 * Applied to every upload, with nothing to turn it off: a stored name is a URL and a path is looked
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

function extensionOf(fileName: string): string {
  return path.extname(fileName).replace(/^\./, '').toLowerCase()
}

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
 * An asset is a file a user uploaded: its bytes live in the `assets` table, while its name and place
 * in the site live in the matching `tree` row, which shares its ID. Both are written together — an
 * asset with no tree row would be unreachable, and a tree row with no asset would be a broken link.
 *
 * The database is always the one durable copy, whatever else is also configured (a blob target such
 * as `s3` mirrors bytes via `dispatchStorage` rather than being read from directly) — but it is not
 * what answers a request for a file. That path and its caches are `models/assetServing.ts`; the
 * write paths here call into it only to say an asset they changed must be forgotten.
 */
class Assets {
  /**
   * Read per upload rather than held anywhere, so changing it in the admin area applies to the next
   * file rather than to the next restart. Anything unrecognized is treated as the default.
   */
  conflictBehaviorFor(siteId: string): UploadConflictBehavior {
    const configured = CARDINAL.sites[siteId]?.config?.uploads?.conflictBehavior
    return UPLOAD_CONFLICT_BEHAVIORS.has(configured) ? configured : 'overwrite'
  }

  /**
   * Store an uploaded file.
   *
   * A file already at this name is settled per the site's {@link UploadConflictBehavior}. An
   * overwrite returns the existing asset's ID, and the name is sanitized, so a caller that means to
   * link to what it just uploaded must read the returned name and ID rather than assume its own.
   *
   * @param folderId The site root when absent.
   */
  async upload({
    siteId,
    locale,
    folderId,
    fileName,
    mimeType,
    data,
    authorId,
    createdAt,
    updatedAt,
    tx,
    afterCommit
  }: {
    siteId: string
    locale: string
    folderId?: string | null
    fileName: string
    mimeType?: string | null
    data: Buffer
    authorId: string
    /**
     * Backdates the new asset's `createdAt` instead of stamping the moment `upload()` runs. Only
     * the migration importer supplies it, carrying a 2.x asset's real creation date across; an
     * ordinary upload leaves it unset and keeps the column's `now()` default.
     */
    createdAt?: string
    /** Same reasoning as {@link createdAt}, for `updatedAt`. */
    updatedAt?: string
    tx?: WikiTx
    afterCommit?: Array<() => Promise<void>>
  }): Promise<Asset> {
    const safeName = sanitizeFileName(fileName)
    if (!safeName) {
      throw new CustomError('assetInvalidFileName', 'This file name cannot be used.')
    }
    const fileExt = extensionOf(safeName)
    // -> The extension decides the type, not the request: the declared one is whatever the client
    //    felt like sending, and this value is what gets served back to a browser later
    const resolvedMime = mime.getType(safeName) ?? mimeType ?? 'application/octet-stream'
    const kind = kindOf(resolvedMime, fileExt)
    const fileData =
      resolvedMime === svgMimeType && CARDINAL.config.security?.uploadScanSVG
        ? sanitizeSvg(data)
        : data

    const thumbnail =
      kind === 'image'
        ? await makeImageThumbnail(fileData, THUMBNAIL_SIZE.width, THUMBNAIL_SIZE.height)
        : null
    const preview = thumbnail?.data ?? null
    const dimensions = dimensionsOf(thumbnail)

    const behavior: UploadConflictBehavior = tx ? 'new' : this.conflictBehaviorFor(siteId)
    const occupant =
      behavior === 'new'
        ? null
        : await CARDINAL.models.tree.getEntryAt({
            siteId,
            locale,
            parentId: folderId,
            fileName: safeName
          })
    if (occupant) {
      if (occupant.type !== 'asset') {
        // -> A page or a folder owns this name, and only its owner can give it up
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
      // -> `createdAt`/`updatedAt` are deliberately not threaded into `replace()`: an occupant here
      //    means this is not the asset's first write, so overwriting `createdAt` would misrepresent
      //    an edit as a creation.
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
        dimensions,
        authorId
      })
    }

    // -> The tree row goes in first: it owns the name, so it settles a collision before any bytes
    //    are written, and what comes back is the name that was free, not always the one asked for.
    const entry = await CARDINAL.models.tree.addAsset({
      parentId: folderId,
      fileName: safeName,
      title: safeName,
      locale,
      siteId,
      meta: {
        fileSize: fileData.length,
        fileExt,
        mimeType: resolvedMime
      },
      ...(tx ? { db: tx } : {})
    })
    const storedName = entry.fileName

    try {
      await (tx ?? CARDINAL.db).insert(assetsTable).values({
        id: entry.id,
        fileName: storedName,
        fileExt,
        kind,
        mimeType: resolvedMime,
        fileSize: fileData.length,
        data: fileData,
        preview,
        meta: dimensions,
        authorId,
        siteId,
        ...(createdAt ? { createdAt: new Date(createdAt) } : {}),
        ...(updatedAt ? { updatedAt: new Date(updatedAt) } : {})
      })
    } catch (err) {
      // -> Nothing points at the tree row now, and leaving it would show a file the site cannot serve
      if (!tx) {
        await CARDINAL.db.delete(treeTable).where(eq(treeTable.id, entry.id))
      }
      throw err
    }

    const folderPath = decodeTreePath(entry.folderPath ?? '') ?? ''

    const settle = async (effect: () => unknown): Promise<void> => {
      if (afterCommit) {
        afterCommit.push(async () => {
          await effect()
        })
      } else {
        await effect()
      }
    }

    await settle(() => this.enqueueTextExtraction(entry.id, fileExt, resolvedMime))

    await settle(() =>
      announce(
        'asset:upload',
        siteId,
        {
          id: entry.id,
          fileName: storedName,
          folderPath,
          siteId,
          authorId
        },
        {
          metadata: { fileSize: fileData.length, mimeType: resolvedMime, kind },
          dispatchExtra: { kind, fileSize: fileData.length }
        }
      )
    )

    // -> Logged from the model rather than the route, so every upload path (file manager, MCP,
    //    importer, storage sync) produces the identical line.
    await settle(() =>
      CARDINAL.logger.info('assets', 'uploaded', {
        site: siteId,
        asset: entry.id,
        path: assetPath(folderPath, storedName),
        bytes: fileData.length,
        kind,
        ...actorFields(authorId)
      })
    )

    return {
      id: entry.id,
      fileName: storedName,
      fileExt,
      kind,
      mimeType: resolvedMime,
      fileSize: fileData.length,
      folderPath,
      title: entry.title,
      hasPreview: Boolean(preview),
      ...dimensions,
      // -> Only the `assets` row receives the override, and `assetSelection` reads these two from
      //    there, so echoing it back rather than `entry.createdAt` is what a follow-up read shows.
      createdAt: createdAt ? new Date(createdAt) : entry.createdAt,
      updatedAt: updatedAt ? new Date(updatedAt) : entry.updatedAt,
      locale
    }
  }

  /**
   * Replace an existing asset's contents in place, for an upload that landed on it under the
   * `overwrite` conflict behavior.
   *
   * The asset keeps its ID, its name and its place in the tree, so every page and every link already
   * pointing at the file goes on working and resolves to the new bytes. The name it keeps is the
   * stored one, while the extension and type are the incoming file's — the two only differ when a
   * browser sent `Photo.PNG` for what is stored as `photo.png`.
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
    dimensions,
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
    dimensions: { width?: number; height?: number }
    authorId: string
  }): Promise<Asset> {
    await CARDINAL.db
      .update(assetsTable)
      .set({
        fileExt,
        kind,
        mimeType,
        fileSize: data.length,
        data,
        preview,
        searchContent: null,
        ts: null,
        meta: sql`(coalesce(${assetsTable.meta}, '{}'::jsonb) - 'width' - 'height') || ${JSON.stringify(dimensions)}::jsonb`,
        authorId,
        updatedAt: sql`now()`
      })
      .where(eq(assetsTable.id, id))
    // -> The tree carries its own copy of these, and it is what a folder listing reads
    await CARDINAL.db
      .update(treeTable)
      .set({ meta: { fileSize: data.length, fileExt, mimeType }, updatedAt: sql`now()` })
      .where(eq(treeTable.id, id))

    // -> The path still resolves to this asset, but the ETag is the modification time, so a reader
    //    holding the old file has to be told to fetch again. The cached bytes are keyed by that
    //    same time and so already unreachable, but are dropped rather than left for the sweep.
    CARDINAL.models.assetServing.forgetPath(siteId, folderPath, fileName)
    await CARDINAL.models.assetServing.dropCachedContent([id])

    await this.enqueueTextExtraction(id, fileExt, mimeType)

    await announce(
      'asset:edit',
      siteId,
      { id, fileName, folderPath, siteId, authorId },
      {
        metadata: { fileSize: data.length, mimeType, kind },
        dispatchExtra: { kind, fileSize: data.length }
      }
    )

    // -> Still an upload from the operator's point of view: somebody sent a file and the site serves
    //    those bytes at that path. `overwrite` is what distinguishes it from a name nothing held.
    CARDINAL.logger.info('assets', 'uploaded', {
      site: siteId,
      asset: id,
      path: assetPath(folderPath, fileName),
      bytes: data.length,
      kind,
      overwrite: true,
      ...actorFields(authorId)
    })

    const updated = await this.getAsset(siteId, id)
    // -> Only if the row vanished between the update and the read — deleted mid-upload. Answering
    //    with what was written beats failing a request that did land.
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
        ...dimensions,
        locale,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    )
  }

  private async enqueueTextExtraction(
    assetId: string,
    fileExt: string,
    mimeType: string
  ): Promise<void> {
    const ocrKind = ocrKindOf(fileExt, mimeType)
    if (!ocrKind) {
      return
    }
    try {
      if (ocrKind === 'pdf') {
        await CARDINAL.scheduler.addJob({ task: 'extractAssetText', payload: { assetId } })
      } else if (await ocrAvailable('image')) {
        await CARDINAL.scheduler.addJob({ task: 'ocrAsset', payload: { assetId } })
      }
    } catch (err) {
      CARDINAL.logger.warn('assets', 'could not queue text extraction', {
        asset: assetId,
        error: err
      })
    }
  }

  async setSearchContent(id: string, text: string | null): Promise<void> {
    const content = text?.trim() ? text : null
    await CARDINAL.db
      .update(assetsTable)
      .set({
        searchContent: content,
        ts: content === null ? null : sql`to_tsvector('simple', ${content}::text)`
      })
      .where(eq(assetsTable.id, id))
  }

  /** An asset's metadata, without its bytes. */
  async getAsset(siteId: string, id: string): Promise<Asset | null> {
    const results = await CARDINAL.db
      .select(assetSelection)
      .from(assetsTable)
      .innerJoin(treeTable, eq(treeTable.id, assetsTable.id))
      .where(and(eq(assetsTable.id, id), eq(assetsTable.siteId, siteId)))
      .limit(1)

    const row = results[0]
    return row ? toAsset(row) : null
  }

  /**
   * Every asset of a site, metadata only — no bytes, no pagination — for a full walk, such as a
   * file-backed storage target reconciling its repo against the DB. A caller that needs the bytes
   * fetches them per asset via `getContent()`.
   */
  async listAllForSite(
    siteId: string
  ): Promise<
    { id: string; kind: AssetKind; folderPath: string; fileName: string; fileSize: number }[]
  > {
    const rows = await CARDINAL.db
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
   * site.
   *
   * The path lives on the tree row rather than on the asset, so the lookup splits it the way the
   * tree stores it, the folder as an ltree. Both halves are lowercased, because that is what an
   * upload stored them as.
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
    const primaryLocale = CARDINAL.sites[siteId]?.config?.locales?.primary ?? 'en'

    const results = await CARDINAL.db
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
   * An asset's bytes, along with what to serve them as.
   *
   * Not scoped to a site, unlike the rest: the ID is a UUID nobody can guess, and the routes that
   * use this are the public ones, which have no site of their own to check against.
   */
  async getContent(
    id: string
  ): Promise<{ data: Buffer; mimeType: string; fileName: string } | null> {
    const results = await CARDINAL.db
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
   * such as a storage target's `exportAll`.
   *
   * Paged by primary key rather than pulled in one query: a site's assets can run into the gigabytes
   * once bytes are included, so this keeps memory bounded to one batch. `id`'s btree index keeps
   * `id > cursor` cheap, unlike an `OFFSET` that re-scans everything before it on every page.
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
      const rows = await CARDINAL.db
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
   * An asset's thumbnail, with what `/_thumb/` needs to decide who may see it. Null when there is
   * no such asset or it has no thumbnail — the normal state for anything that is not an image, for
   * images uploaded while Sharp was unavailable, and for one a storage target's `purge()` nulled.
   */
  async getThumbnail(id: string): Promise<AssetThumbnail | null> {
    const results = await CARDINAL.db
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

    await CARDINAL.models.tree.renameEntry({ id, fileName: safeName, title: safeName })
    await CARDINAL.db
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
    await CARDINAL.db
      .update(treeTable)
      .set({ meta: { fileSize: asset.fileSize, fileExt, mimeType: resolvedMime } })
      .where(eq(treeTable.id, id))

    // -> Both ends of the rename: the name it left, and the name it took, which something else may
    //    have been resolved at before it was freed up
    CARDINAL.models.assetServing.forgetPath(siteId, asset.folderPath, asset.fileName)
    CARDINAL.models.assetServing.forgetPath(siteId, asset.folderPath, safeName)
    await CARDINAL.models.assetServing.dropCachedContent([id])

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
   * Move an asset into another folder, keeping its name, contents and locale untouched.
   *
   * The destination is resolved the same way an upload's is — see `Tree#moveEntry`. Moving an asset
   * into the folder it already sits in is a no-op: nothing is touched, and no `asset:move` fires, so
   * a caller cannot be told a move happened when nothing changed.
   *
   * `previousFolderPath` on the announcement is what a storage handler keys its own copy/rename on.
   */
  async moveAsset({
    siteId,
    id,
    folderId,
    parentPath
  }: {
    siteId: string
    id: string
    folderId?: string | null
    parentPath?: string | null
  }): Promise<Asset | null> {
    const asset = await this.getAsset(siteId, id)
    if (!asset) {
      return null
    }

    const moved = await CARDINAL.models.tree.moveEntry({ id, siteId, folderId, parentPath })
    if (!moved) {
      return null
    }
    const newFolderPath = decodeTreePath(moved.folderPath ?? '') ?? ''
    if (newFolderPath === asset.folderPath) {
      return asset
    }

    // -> Both ends of the move: the folder it left, and the folder it arrived in
    CARDINAL.models.assetServing.forgetPath(siteId, asset.folderPath, asset.fileName)
    CARDINAL.models.assetServing.forgetPath(siteId, newFolderPath, asset.fileName)
    await CARDINAL.models.assetServing.dropCachedContent([id])

    await announce(
      'asset:move',
      siteId,
      {
        id,
        fileName: asset.fileName,
        folderPath: newFolderPath,
        previousFolderPath: asset.folderPath,
        siteId
      },
      { dispatchExtra: { kind: asset.kind, fileSize: asset.fileSize } }
    )

    return this.getAsset(siteId, id)
  }

  /**
   * Delete an asset and the tree entry that points at it.
   *
   * @param authorId For the lifecycle log line alone — see {@link AssetDeleteOptions}.
   */
  async deleteAsset(
    siteId: string,
    id: string,
    { authorId }: AssetDeleteOptions = {}
  ): Promise<boolean> {
    const asset = await this.getAsset(siteId, id)
    if (!asset) {
      return false
    }
    await CARDINAL.db.delete(assetsTable).where(eq(assetsTable.id, id))
    await CARDINAL.models.tree.deleteEntry(id)

    CARDINAL.models.assetServing.forgetPath(siteId, asset.folderPath, asset.fileName)
    await CARDINAL.models.assetServing.dropCachedContent([id])

    // -> `contentSyncState.contentId` isn't a real FK (it can point at a page or an asset), so nothing
    //    at the db level drops the sync-state rows for this asset on its own.
    await CARDINAL.models.contentSync.forgetContent('asset', id)

    await announce(
      'asset:delete',
      siteId,
      { id, fileName: asset.fileName, folderPath: asset.folderPath, siteId },
      { dispatchExtra: { kind: asset.kind, fileSize: asset.fileSize } }
    )

    CARDINAL.logger.info('assets', 'deleted', {
      site: siteId,
      asset: id,
      path: assetPath(asset.folderPath, asset.fileName),
      kind: asset.kind,
      ...actorFields(authorId)
    })

    return true
  }

  /**
   * Delete the assets left behind by a folder deletion, which removed their tree entries already.
   *
   * @param authorId For the lifecycle log lines alone — see {@link AssetDeleteOptions}.
   */
  async deleteOrphaned(
    siteId: string,
    entries: DeletedEntry[],
    { authorId }: AssetDeleteOptions = {}
  ): Promise<void> {
    if (entries.length < 1) {
      return
    }
    const ids = entries.map((entry) => entry.id)
    // -> `kind`/`fileSize` come back rather than going with the rows: dispatching a delete needs
    //    them to classify against a target's `contentTypes.activeTypes`, and this is the last point
    //    at which the database still has them
    const deleted = await CARDINAL.db
      .delete(assetsTable)
      .where(inArray(assetsTable.id, ids))
      .returning({ id: assetsTable.id, kind: assetsTable.kind, fileSize: assetsTable.fileSize })
    const deletedById = new Map(deleted.map((row) => [row.id, row]))

    // -> Which paths they sat at is no longer knowable from the tree: those rows went with the folder
    CARDINAL.models.assetServing.forgetAllPaths()
    await CARDINAL.models.assetServing.dropCachedContent(ids)

    await CARDINAL.models.contentSync.forgetContentBatch('asset', ids)

    // -> One announcement per file, as deleting them one at a time would have sent: a subscriber
    //    mirroring the wiki has to hear about each file, not about the folder it sat in
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
      // -> `cascade` says it was the folder over it that was deleted, not the file itself
      CARDINAL.logger.info('assets', 'deleted', {
        site: siteId,
        asset: entry.id,
        path: assetPath(entry.folderPath, entry.fileName),
        ...(row?.kind ? { kind: row.kind } : {}),
        cascade: 'folder',
        ...actorFields(authorId)
      })
    }
  }
}

export const assets = new Assets()
