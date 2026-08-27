import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import os from 'node:os'
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
import { CustomError } from '../helpers/common.ts'
import { EXPORT_FORMAT_VERSION } from './export.ts'

/** How long an uploaded import sits on disk before `purgeExpired` sweeps it, in seconds. */
const IMPORT_TTL_SECONDS = 24 * 60 * 60

/**
 * The largest a single decompressed tar entry may be before `readArchive` aborts.
 *
 * A tar entry's declared size is not something the archive can lie about: the format's own parser
 * reads exactly that many decompressed bytes for that entry and no more, so this is checked against
 * `entry.size` before a single byte of the entry's body is consumed. Set to the same magnitude as
 * `importUploadLimit` (`api/system.ts`'s compressed-upload cap) — no legitimate single asset inside
 * an archive should decompress to more than the whole upload was ever allowed to weigh.
 */
export const IMPORT_MAX_ENTRY_BYTES = 500 * 1024 * 1024

/**
 * The largest an archive's total decompressed size may be, summed across every entry, before
 * `readArchive` aborts.
 *
 * A generous multiple of {@link IMPORT_MAX_ENTRY_BYTES} rather than 1:1 with it — a real export
 * carries many assets, not one — while still refusing to let a crafted archive's decompressed total
 * grow unbounded. This is the actual fix for the "zip bomb" concern: bounding real decompressed bytes
 * read, rather than trying to infer one from a compression ratio.
 */
export const IMPORT_MAX_TOTAL_BYTES = 4 * IMPORT_MAX_ENTRY_BYTES

export interface ImportResult {
  pages: number
  tree: number
  assets: number
  groups: number
}

/** `readArchive`'s two size ceilings, overridable so a test can trip them without gigabyte fixtures. */
export interface ReadArchiveLimits {
  maxEntryBytes?: number
  maxTotalBytes?: number
}

/** What `readArchive` hands back — see its own doc comment for what goes where and why. */
export interface ArchiveContents {
  /** Every entry except an asset blob, kept fully in memory since each must be parsed/validated
   *  before anything is written: `manifest.json`, `site.json`, `pages.json`, `tree.json`,
   *  `groups.json`, `assets/manifest.json`. */
  entries: Record<string, Buffer>
  /** `assets/<id>.data` / `assets/<id>.preview` entry name -> path of the file it was staged to. */
  assetBlobs: Record<string, string>
  /** Directory the blobs above were staged into. The caller must remove it once done reading them. */
  stagingDir: string
}

/** Whether a tar entry is one of the asset byte blobs `exportSite` writes, rather than a JSON entry. */
function isAssetBlobEntry(name: string): boolean {
  return name.startsWith('assets/') && (name.endsWith('.data') || name.endsWith('.preview'))
}

/**
 * Read a gzipped tarball's entries apart, staging each asset's bytes to disk rather than holding the
 * whole archive resident in memory.
 *
 * The JSON entries (`manifest.json`, `site.json`, `pages.json`, `tree.json`, `groups.json`,
 * `assets/manifest.json`) need to be parsed and validated *before* anything is written (see
 * `importSite`), so those alone are buffered fully and returned in `entries`. Every `assets/<id>.data`
 * / `assets/<id>.preview` entry is instead piped straight to its own file under a fresh staging
 * directory, named by a running index rather than by the entry's own path — the archive's entry names
 * never become part of a filesystem path this writes to, which is what keeps this immune to zip-slip
 * even though nothing about the archive format here changed.
 *
 * Bounded two ways, both checked against `entry.size` (the tar header's own declared byte count for
 * that entry, which the format's parser enforces mechanically — not something a crafted archive can
 * inflate past): no single entry may decompress past `limits.maxEntryBytes`, and the running total
 * across every entry may not pass `limits.maxTotalBytes`. Either one aborts the whole read with a
 * clear error — the entry that tripped it is drained, not stored, and every entry after it is
 * skipped outright rather than continuing to accumulate past a read that has already failed.
 *
 * `tar`'s `list()` (aka `readArchive` -> `listTarball`) reads and gzip-decompresses `filePath` itself,
 * handing each entry back as a readable stream via `onReadEntry` — the promise it returns resolves
 * only once every entry has been fully parsed out of the underlying file, by which point every
 * `data`/`end` pair (or asset pipe) below has already fired.
 */
export async function readArchive(
  filePath: string,
  limits: ReadArchiveLimits = {}
): Promise<ArchiveContents> {
  const maxEntryBytes = limits.maxEntryBytes ?? IMPORT_MAX_ENTRY_BYTES
  const maxTotalBytes = limits.maxTotalBytes ?? IMPORT_MAX_TOTAL_BYTES

  const entries: Record<string, Buffer> = {}
  const assetBlobs: Record<string, string> = {}
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-import-read-'))
  const pendingWrites: Promise<void>[] = []
  let totalBytes = 0
  let overageMessage: string | null = null
  let blobIndex = 0

  const cleanupStagingDir = () =>
    fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {})

  try {
    await listTarball({
      file: filePath,
      onReadEntry: (entry) => {
        // -> `create()` (see `models/export.ts`) emits a directory entry for `assets/` itself, ahead
        //    of the files inside it -- nothing this reads back ever needs that entry, only the files.
        if (entry.type !== 'File') {
          return
        }
        // -> Once one entry has already tripped a limit, every entry after it is drained (`list()`
        //    resumes any entry that gets no `data` listener) rather than accumulated further.
        if (overageMessage) {
          return
        }
        if (entry.size > maxEntryBytes) {
          overageMessage = `Malformed import archive: ${entry.path} is ${entry.size} decompressed bytes, over the ${maxEntryBytes}-byte single-entry limit.`
          return
        }
        totalBytes += entry.size
        if (totalBytes > maxTotalBytes) {
          overageMessage = `Malformed import archive: decompressed size exceeds the ${maxTotalBytes}-byte import limit.`
          return
        }

        if (isAssetBlobEntry(entry.path)) {
          // -> Staged straight to a file rather than buffered: an asset's bytes never need to sit in
          //    memory while the archive is being read, only once `importSite` is actually ready to
          //    insert that one row (see there).
          const stagedPath = path.join(stagingDir, `${blobIndex++}.blob`)
          assetBlobs[entry.path] = stagedPath
          const out = createWriteStream(stagedPath)
          pendingWrites.push(
            new Promise<void>((resolve, reject) => {
              out.on('finish', resolve)
              out.on('error', reject)
              entry.on('error', reject)
            })
          )
          entry.pipe(out)
        } else {
          const chunks: Buffer[] = []
          entry.on('data', (chunk) => chunks.push(chunk))
          entry.on('end', () => {
            entries[entry.path] = Buffer.concat(chunks)
          })
        }
      }
    })
    await Promise.all(pendingWrites)
  } catch (err) {
    await cleanupStagingDir()
    throw err
  }

  if (overageMessage) {
    await cleanupStagingDir()
    throw new Error(overageMessage)
  }

  return { entries, assetBlobs, stagingDir }
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
   * Save an uploaded archive to `<dataPath>/imports/`, streaming it straight from the request rather
   * than buffering the whole thing in memory first — a whole archive materialised as one `Buffer` in
   * the request thread was previously what stood between one legitimate large import and an OOM (see
   * `api/system.ts`'s content-type parser, which hands this the raw request stream rather than a
   * parsed buffer).
   *
   * `bodyLimit` is enforced here as bytes arrive, since a streamed body bypasses Fastify's own
   * automatic `Content-Length` check (that check only runs for its `parseAs: 'buffer' | 'string'`
   * parsers). The gzip magic number is checked once the write has finished — the same check the route
   * used to make before any bytes were saved, just after rather than before the save now that there
   * is no in-memory buffer left to check it against first. Any failure removes the partial file
   * before rejecting.
   *
   * @returns The path the queued job reads it back from.
   * @throws {CustomError} the body exceeded `bodyLimit` (413), nothing was sent (400), or the saved
   *   file's first two bytes are not the gzip magic number (400).
   */
  async saveUpload(stream: NodeJS.ReadableStream, bodyLimit: number): Promise<string> {
    await fs.mkdir(this.importsPath, { recursive: true })
    const filePath = path.join(this.importsPath, `${crypto.randomUUID()}.tar.gz`)
    let received = 0

    const limitEnforcer = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length
        if (received > bodyLimit) {
          callback(
            new CustomError(
              'importUploadTooLarge',
              `The archive is larger than the ${Math.round(bodyLimit / 1024 / 1024)} MB import limit.`,
              413
            )
          )
          return
        }
        callback(null, chunk)
      }
    })

    try {
      await pipeline(stream, limitEnforcer, createWriteStream(filePath))
    } catch (err) {
      await fs.rm(filePath, { force: true }).catch(() => {})
      throw err
    }

    if (received === 0) {
      await fs.rm(filePath, { force: true }).catch(() => {})
      throw new CustomError('importEmptyFile', 'No archive was sent.', 400)
    }

    const fd = await fs.open(filePath, 'r')
    const header = Buffer.alloc(2)
    try {
      await fd.read(header, 0, 2, 0)
    } finally {
      await fd.close()
    }
    if (header[0] !== 0x1f || header[1] !== 0x8b) {
      await fs.rm(filePath, { force: true }).catch(() => {})
      throw new CustomError(
        'importNotGzip',
        'Not a gzip archive, whatever the request said it was.',
        400
      )
    }

    return filePath
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
   * @param filePath Path to the uploaded archive, as returned by `saveUpload`.
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
    const { entries, assetBlobs, stagingDir } = await readArchive(filePath)

    try {
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
      const pageIdMap = new Map<string, string>(
        pageRows.map((row) => [row.id, crypto.randomUUID()])
      )
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

      // -> Each asset's bytes were staged to disk by `readArchive` rather than held in memory — read
      //    back here, one asset at a time, only now that a row is actually about to be built for it.
      const mappedAssetRows = await Promise.all(
        assetManifest.map(async (meta) => {
          const dataPath = assetBlobs[`assets/${meta.id}.data`]
          const previewPath = assetBlobs[`assets/${meta.id}.preview`]
          return {
            ...meta,
            id: assetIdMap.get(meta.id),
            data: dataPath ? await fs.readFile(dataPath) : null,
            preview: previewPath ? await fs.readFile(previewPath) : null,
            siteId: targetSiteId,
            authorId: importedById
          }
        })
      )

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
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

export const importModel = new ImportModel()
