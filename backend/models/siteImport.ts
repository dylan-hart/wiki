import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { list as listTarball } from 'tar'
import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  assets as assetsTable,
  groups as groupsTable,
  pages as pagesTable,
  sites as sitesTable,
  tree as treeTable
} from '../db/schema.ts'
import { EXPORT_FORMAT_VERSION } from './export.ts'

/** How long an uploaded import sits on disk before `purgeExpired` sweeps it, in seconds. */
const IMPORT_TTL_SECONDS = 24 * 60 * 60

/**
 * Ceiling on one tar entry's decompressed size, and on the archive's total decompressed size across
 * every entry combined. `readArchive` used to hold both with no limit at all: a crafted or merely
 * very large archive (compression ratios well past 100:1 are ordinary for repetitive text) could
 * exhaust the process's heap decompressing a single entry, in-process, before a single database row
 * was ever touched (OpenProject #2213, audit `06-files-uploads-storage.md` §5). The route this backs
 * requires `manage:system`, so this is a robustness ceiling against a genuinely oversized *legitimate*
 * archive rather than a defense against an untrusted caller — sized generously above what a real
 * site's content should ever decompress to.
 */
const MAX_ENTRY_BYTES = 200 * 1024 * 1024

/** See {@link MAX_ENTRY_BYTES}. */
const MAX_ARCHIVE_DECOMPRESSED_BYTES = 1024 * 1024 * 1024

export interface ImportResult {
  pages: number
  tree: number
  assets: number
  groups: number
}

/**
 * Read a gzipped tarball fully into memory as `{ entryName: bytes }`.
 *
 * Buffering every entry rather than streaming each one against the database as it arrives: the JSON
 * entries need to be parsed and validated *before* anything is written (see `importSite`), and the
 * binary asset entries are headed for a single transaction together with everything else, so nothing
 * here can be applied incrementally as it is read regardless. `tar`'s `t()` (list) reads and
 * gzip-decompresses `filePath` itself, handing each entry back as a readable stream via
 * `onReadEntry` — the promise it returns resolves only once every entry has been fully parsed out of
 * the underlying file, by which point every `data`/`end` pair below has already fired.
 *
 * Bounded by {@link MAX_ENTRY_BYTES} (one entry) and {@link MAX_ARCHIVE_DECOMPRESSED_BYTES} (every
 * entry combined) — see those constants' own doc comment. Tripping either stops accumulating bytes
 * immediately (so the offending/remaining data is never actually held), but still lets `tar` finish
 * walking the underlying file before throwing, rather than tearing the read down mid-entry: this is a
 * robustness ceiling, not something that needs to react within the same tick, and finishing the walk
 * is simpler than reasoning about `tar`'s own cleanup of a `list()` aborted partway through. Exported
 * for `models/siteImport.test.ts`, which exercises it directly against real tar fixtures rather than
 * through the far more expensive, DB-backed `importSite` round trip the rest of this file's tests
 * use. `limits` defaults to the real, module-level ceilings — `importSite` never passes it — and
 * exists so that test can exercise the ceiling logic itself against small fixtures instead of
 * needing to actually build a multi-hundred-megabyte archive per assertion.
 */
export async function readArchive(
  filePath: string,
  limits: { maxEntryBytes?: number; maxTotalBytes?: number } = {}
): Promise<Record<string, Buffer>> {
  const maxEntryBytes = limits.maxEntryBytes ?? MAX_ENTRY_BYTES
  const maxTotalBytes = limits.maxTotalBytes ?? MAX_ARCHIVE_DECOMPRESSED_BYTES
  const entries: Record<string, Buffer> = {}
  let totalBytes = 0
  let overflow: Error | null = null

  await listTarball({
    file: filePath,
    onReadEntry: (entry) => {
      // -> `create()` (see `models/export.ts`) emits a directory entry for `assets/` itself, ahead of
      //    the files inside it -- nothing this reads back ever needs that entry, only the files.
      if (entry.type !== 'File') {
        return
      }
      const chunks: Buffer[] = []
      let entryBytes = 0
      let entryOverflowed = false
      entry.on('data', (chunk) => {
        if (overflow || entryOverflowed) {
          return
        }
        entryBytes += chunk.length
        totalBytes += chunk.length
        if (entryBytes > maxEntryBytes) {
          entryOverflowed = true
          overflow ??= new Error(
            `Malformed or oversized import archive: entry '${entry.path}' decompresses past the ${Math.round(maxEntryBytes / 1024 / 1024)} MB per-entry limit.`
          )
          return
        }
        if (totalBytes > maxTotalBytes) {
          overflow ??= new Error(
            `Malformed or oversized import archive: total decompressed size exceeds the ${Math.round(maxTotalBytes / 1024 / 1024)} MB limit.`
          )
          return
        }
        chunks.push(chunk)
      })
      entry.on('end', () => {
        if (!overflow && !entryOverflowed) {
          entries[entry.path] = Buffer.concat(chunks)
        }
      })
    }
  })

  if (overflow) {
    throw overflow
  }
  return entries
}

/** Read and parse one JSON entry, or fail with a message naming what was missing/malformed. */
function readJson<T>(entries: Record<string, Buffer>, name: string): T {
  const buf = entries[name]
  if (!buf) {
    throw new Error(`Malformed import archive: missing ${name}.`)
  }
  try {
    return JSON.parse(buf.toString('utf8')) as T
  } catch {
    throw new Error(`Malformed import archive: ${name} is not valid JSON.`)
  }
}

/**
 * Content import model
 *
 * The mirror image of `models/export.ts`: reads back a tarball `exportSite` produced and restores it
 * into a target site, for the "Import content" system utility. Structure and version are checked
 * before anything is opened against the database, and the restore itself runs inside a single
 * transaction, so a mid-import failure — a malformed row, a constraint violation, the process dying —
 * leaves the target site exactly as it was rather than half-restored.
 *
 * Two things the export cannot carry are resolved here, deliberately and not as a fallback for a case
 * that "shouldn't occur":
 *
 * - **Site content is replaced, not merged.** Every existing page, tree entry and asset belonging to
 *   the target site is deleted before the imported ones are inserted. Pages and tree entries are
 *   matched by path/locale with no natural merge order, so "restore" is defined as putting the site
 *   back to exactly what the archive describes, not layering it on top of whatever is already there.
 * - **Pages, tree entries and assets get fresh ids, unlike groups.** `pages.id`/`tree.id`/`assets.id`
 *   are one global primary-key space, not scoped per site, so re-using the archive's own ids would
 *   collide with the source site's rows the moment it still exists in the same database — restoring a
 *   backup while the original site is still around, or duplicating one site's content into another,
 *   are both ordinary uses of this, not edge cases. A page's and an asset's tree entry share its id
 *   (see below), so the new id is generated once per page/asset and carried through to its tree row
 *   rather than each row picking its own.
 * - **Groups are upserted by id, not replaced.** Unlike pages/tree/assets, groups are global rather
 *   than site-scoped (see CLAUDE.md's Permissions section) — wiping the whole table to restore one
 *   site's export would take every other site's access model with it. An imported group updates one
 *   already on this instance when its id matches (the ordinary case: restoring a backup onto the same
 *   instance that produced it) or is inserted as a new one when it does not (importing onto a
 *   different instance).
 * - **Authorship cannot travel with the content**, since accounts are not part of the export — every
 *   imported page's and asset's author/creator/owner columns are rewritten to the account performing
 *   the import.
 * - **The target site's own config, hostname and enabled state are left untouched.** `site.json` is
 *   validated as present (it is part of the archive's structure) but its contents are not applied —
 *   only pages, tree entries, assets and groups are what this restores.
 */
class ImportModel {
  /** `<dataPath>/imports` — created on first use, same as the export/icon/asset caches. */
  get importsPath(): string {
    return path.resolve(WIKI.ROOTPATH, WIKI.config.dataPath, 'imports')
  }

  /**
   * Stream an uploaded archive straight to `<dataPath>/imports/` rather than buffering the whole
   * request body in memory first (OpenProject #2213): `api/system.ts`'s content-type parser for this
   * route hands over the raw request stream, not a `Buffer` — the route's own `bodyLimit` machinery
   * only applies to Fastify's `parseAs: 'buffer'`/`'string'` fast paths, so this method is what
   * actually enforces `maxBytes` now, destroying the partial file the moment the running total passes
   * it rather than letting the whole upload land on disk first. The gzip magic number is checked
   * against the first bytes actually written, not trusted from the `Content-Type` header alone — the
   * same check the old buffered version made against `data[0]`/`data[1]`.
   *
   * @returns The path the queued job reads the archive back from, and its size in bytes.
   */
  async streamUpload(
    payload: NodeJS.ReadableStream,
    maxBytes: number
  ): Promise<{ filePath: string; size: number }> {
    await fs.mkdir(this.importsPath, { recursive: true })
    const filePath = path.join(this.importsPath, `${crypto.randomUUID()}.tar.gz`)

    let size = 0
    let firstBytes = Buffer.alloc(0)
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (firstBytes.length < 2) {
          firstBytes = Buffer.concat([firstBytes, chunk]).subarray(0, 2)
        }
        size += chunk.length
        if (size > maxBytes) {
          callback(
            Object.assign(
              new Error(
                `The archive is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`
              ),
              { statusCode: 400 }
            )
          )
          return
        }
        callback(null, chunk)
      }
    })

    try {
      await pipeline(payload, limiter, fsSync.createWriteStream(filePath))
    } catch (err) {
      await fs.unlink(filePath).catch(() => {})
      throw err
    }

    if (size < 1) {
      await fs.unlink(filePath).catch(() => {})
      throw Object.assign(new Error('No archive was sent.'), { statusCode: 400 })
    }
    if (firstBytes[0] !== 0x1f || firstBytes[1] !== 0x8b) {
      await fs.unlink(filePath).catch(() => {})
      throw Object.assign(new Error('Not a gzip archive, whatever the request said it was.'), {
        statusCode: 400
      })
    }

    return { filePath, size }
  }

  /**
   * Delete one uploaded archive. Best-effort and idempotent — called once the import task is done
   * with it (success or failure alike, unlike an export's tarball, which is a downloadable product
   * rather than a working file).
   */
  async deleteUpload(filePath: string): Promise<void> {
    await fs.unlink(filePath).catch(() => {})
  }

  /**
   * Sweep `<dataPath>/imports/` of anything older than the TTL — an upload whose job never ran to
   * completion to clean up after itself (a crash mid-import). Safe to call when the directory does
   * not exist yet.
   *
   * @returns How many files were removed
   */
  async purgeExpired(): Promise<number> {
    let files: string[]
    try {
      files = await fs.readdir(this.importsPath)
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return 0
      }
      throw err
    }

    const cutoff = Temporal.Now.instant().subtract({ seconds: IMPORT_TTL_SECONDS })
    let purged = 0
    for (const entry of files) {
      const entryPath = path.join(this.importsPath, entry)
      const stat = await fs.stat(entryPath)
      if (Temporal.Instant.compare(stat.mtime.toTemporalInstant(), cutoff) < 0) {
        await fs.unlink(entryPath)
        purged++
      }
    }
    return purged
  }

  /**
   * Restore a tarball produced by `exportModel.exportSite` into `targetSiteId`.
   *
   * @param filePath Path to the uploaded archive, as returned by `streamUpload`.
   * @param targetSiteId The site pages/tree/assets are restored into. Must already exist.
   * @param importedById The account performing the import — every restored page/asset's
   *   author/creator/owner columns are rewritten to this id, since accounts are not part of the
   *   archive.
   * @returns How many rows of each kind were restored, which the caller (`importContent`'s task)
   *   records on the job's history row via `WIKI.models.jobs.setResult`.
   */
  async importSite(
    filePath: string,
    targetSiteId: string,
    importedById: string
  ): Promise<ImportResult> {
    const entries = await readArchive(filePath)

    // -> Structure and version are validated in full before a single query runs against the
    //    database — an archive this code does not recognize is refused outright, never restored
    //    best-effort. `readJson` itself is what enforces every entry's mere presence.
    const manifest = readJson<{ formatVersion?: number }>(entries, 'manifest.json')
    if (manifest.formatVersion !== EXPORT_FORMAT_VERSION) {
      throw new Error(
        `Unsupported import archive version ${manifest.formatVersion ?? '(none)'} — this instance can only restore version ${EXPORT_FORMAT_VERSION} archives.`
      )
    }
    // -> Validated for presence, deliberately unused: the target site's own config/hostname/enabled
    //    state are not part of what an import restores (see the class-level doc comment).
    readJson<Record<string, any>>(entries, 'site.json')
    const pageRows = readJson<Record<string, any>[]>(entries, 'pages.json')
    const treeRows = readJson<Record<string, any>[]>(entries, 'tree.json')
    const groupRows = readJson<Record<string, any>[]>(entries, 'groups.json')
    const assetManifest = readJson<Record<string, any>[]>(entries, 'assets/manifest.json')

    const targetSiteRows = await WIKI.db
      .select({ id: sitesTable.id })
      .from(sitesTable)
      .where(eq(sitesTable.id, targetSiteId))
      .limit(1)
    if (!targetSiteRows[0]) {
      throw new Error(`Target site ${targetSiteId} does not exist.`)
    }

    // -> Fresh ids for pages and assets, computed up front so a tree entry can be matched to the
    //    same new id its page/asset just got — see the class-level doc comment.
    const pageIdMap = new Map<string, string>(pageRows.map((row) => [row.id, crypto.randomUUID()]))
    const assetIdMap = new Map<string, string>(
      assetManifest.map((row) => [row.id, crypto.randomUUID()])
    )

    const mappedPageRows = pageRows.map((row) => ({
      ...row,
      id: pageIdMap.get(row.id),
      siteId: targetSiteId,
      authorId: importedById,
      creatorId: importedById,
      ownerId: importedById
    }))

    const mappedAssetRows = assetManifest.map((meta) => ({
      ...meta,
      id: assetIdMap.get(meta.id),
      data: entries[`assets/${meta.id}.data`] ?? null,
      preview: entries[`assets/${meta.id}.preview`] ?? null,
      siteId: targetSiteId,
      authorId: importedById
    }))

    const mappedTreeRows = treeRows.map((row) => {
      // -> A folder has no page/asset counterpart to stay in step with, so it simply gets a new id
      //    of its own; a page's or asset's tree entry must resolve to the exact id that row just got
      const newId =
        row.type === 'page'
          ? pageIdMap.get(row.id)
          : row.type === 'asset'
            ? assetIdMap.get(row.id)
            : crypto.randomUUID()
      if (!newId) {
        throw new Error(
          `Malformed import archive: tree entry ${row.id} (${row.type}) has no matching entry in ${row.type === 'page' ? 'pages.json' : 'assets/manifest.json'}.`
        )
      }
      return { ...row, id: newId, siteId: targetSiteId }
    })

    await WIKI.db.transaction(async (tx) => {
      // -> Site content is replaced outright — see the class-level doc comment. Deleted before
      //    anything is inserted, all three scoped to the target site alone.
      await tx.delete(assetsTable).where(eq(assetsTable.siteId, targetSiteId))
      await tx.delete(treeTable).where(eq(treeTable.siteId, targetSiteId))
      await tx.delete(pagesTable).where(eq(pagesTable.siteId, targetSiteId))

      // -> Groups are global, so they are upserted by id rather than replaced wholesale — see the
      //    class-level doc comment.
      for (const group of groupRows) {
        await tx
          .insert(groupsTable)
          .values(group as any)
          .onConflictDoUpdate({ target: groupsTable.id, set: group as any })
      }

      if (mappedPageRows.length > 0) {
        await tx.insert(pagesTable).values(mappedPageRows as any)
      }

      if (mappedTreeRows.length > 0) {
        await tx.insert(treeTable).values(mappedTreeRows as any)
      }

      if (mappedAssetRows.length > 0) {
        await tx.insert(assetsTable).values(mappedAssetRows as any)
      }
    })

    return {
      pages: mappedPageRows.length,
      tree: mappedTreeRows.length,
      assets: mappedAssetRows.length,
      groups: groupRows.length
    }
  }
}

export const importModel = new ImportModel()
