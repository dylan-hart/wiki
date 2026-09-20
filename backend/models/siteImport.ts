import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { list as listTarball } from 'tar'
import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { chunk } from 'es-toolkit/array'
import {
  assets as assetsTable,
  groups as groupsTable,
  navigation as navigationTable,
  pageHistory as pageHistoryTable,
  pages as pagesTable,
  sites as sitesTable,
  tree as treeTable
} from '../db/schema.ts'
import type { GroupRule } from './groups.ts'
import { CustomError } from '../helpers/common.ts'
import { purgeFilesOlderThan } from '../helpers/fsPurge.ts'
import { EXPORT_FORMAT_VERSION } from './export.ts'

const IMPORT_TTL_SECONDS = 24 * 60 * 60

/** An imported group rule whose `sites` still names a site id this instance cannot resolve, once the
 *  archive's own source site has been rewritten to `targetSiteId`. */
export interface UnresolvedRuleSite {
  groupId: string
  ruleId: string
  siteId: string
}

/**
 * Postgres's extended-query protocol packs each bound parameter into an Int16 slot in the Bind
 * message, capping a single statement at 65535 of them, and drizzle's `.insert(...).values(rows)`
 * flattens into one bind array of `rows.length * columnCount`. Nothing upstream caps how many rows an
 * archive carries, so without chunking a large-enough site aborts the whole restore with an opaque
 * driver-level bind error rather than a readable "too many rows" one.
 *
 * Each divisor is that table's bound column count: `pages` declares 37 and `models/export.ts`'s
 * `stripDerived` drops three (`ts`, `isSearchableComputed`, `searchContent`) before a row reaches
 * export/import, leaving 34; `tree`, `assets` and `pageHistory` declare 14; `navigation` 5.
 */
export const MAX_BIND_PARAMETERS = 65535
export const PAGE_INSERT_CHUNK_SIZE = Math.floor(MAX_BIND_PARAMETERS / 34)
export const TREE_INSERT_CHUNK_SIZE = Math.floor(MAX_BIND_PARAMETERS / 14)
export const PAGE_HISTORY_INSERT_CHUNK_SIZE = Math.floor(MAX_BIND_PARAMETERS / 14)
export const NAVIGATION_INSERT_CHUNK_SIZE = Math.floor(MAX_BIND_PARAMETERS / 5)
/**
 * Far smaller than an asset row's column count alone would call for: each row also carries the full
 * `data`/`preview` bytea buffers as bind parameter *values*, so a batch blows up the Bind message's
 * byte size long before the parameter-count ceiling above governs it.
 */
export const ASSET_INSERT_CHUNK_SIZE = 50

/**
 * A tar entry's declared size is not something the archive can lie about: the format's own parser
 * reads exactly that many decompressed bytes for that entry and no more, so this is checked against
 * `entry.size` before a single byte of the entry's body is consumed. Same magnitude as
 * `importUploadLimit` (`api/system/transfer.ts`'s compressed-upload cap) — no legitimate single asset
 * should decompress to more than the whole upload was allowed to weigh.
 */
const IMPORT_MAX_ENTRY_BYTES = 500 * 1024 * 1024

/**
 * A generous multiple of {@link IMPORT_MAX_ENTRY_BYTES} rather than 1:1 with it — a real export
 * carries many assets, not one — while still bounding a crafted archive's decompressed total. That
 * bound on real bytes read is the zip-bomb defence; inferring one from a compression ratio is not.
 */
const IMPORT_MAX_TOTAL_BYTES = 4 * IMPORT_MAX_ENTRY_BYTES

export interface ImportResult {
  pages: number
  tree: number
  assets: number
  pageHistory: number
  navigation: number
  groups: number
  unresolvedRuleSites: UnresolvedRuleSite[]
}

/** Overridable so a test can trip `readArchive`'s ceilings without gigabyte fixtures. */
export interface ReadArchiveLimits {
  maxEntryBytes?: number
  maxTotalBytes?: number
}

export interface ArchiveContents {
  /** Every entry except an asset blob, buffered whole since each must be parsed before anything is
   *  written. */
  entries: Record<string, Buffer>
  /** `assets/<id>.data` / `assets/<id>.preview` entry name -> path of the file it was staged to. */
  assetBlobs: Record<string, string>
  /** Staging directory for the blobs above; the caller must remove it once done reading them. */
  stagingDir: string
}

function isAssetBlobEntry(name: string): boolean {
  return name.startsWith('assets/') && (name.endsWith('.data') || name.endsWith('.preview'))
}

/**
 * The JSON entries must be parsed and validated *before* anything is written (see `importSite`), so
 * those alone are buffered whole into `entries`; each asset blob is piped to its own file under a
 * fresh staging directory, named by a running index rather than by the entry's own path — no
 * archive-supplied name ever becomes part of a filesystem path this writes to, which is what keeps
 * it immune to zip-slip.
 *
 * Tripping either ceiling aborts the read: the entry that tripped it is drained rather than stored,
 * and every entry after it is skipped rather than accumulated past a read that has already failed.
 *
 * `listTarball`'s promise resolves only once every entry has been fully parsed out of the underlying
 * file, by which point every `data`/`end` pair (or asset pipe) below has already fired.
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
        // -> `create()` emits a directory entry for `assets/` itself; only the files matter here.
        if (entry.type !== 'File') {
          return
        }
        // -> `list()` resumes any entry that gets no `data` listener, so returning here drains the
        //    rest of the archive rather than accumulating it.
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

/**
 * Exported for `models/replicationImport.ts`, which reads apart the same kind of tarball for its own,
 * differently-shaped set of JSON entries.
 */
export function readJson<T>(entries: Record<string, Buffer>, name: string): T {
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
 * The mirror image of `models/export.ts`: restores a tarball `exportSite` produced into a target
 * site. Structure and version are checked before anything is opened against the database, and the
 * restore runs inside a single transaction, so a mid-import failure leaves the target site exactly as
 * it was rather than half-restored.
 *
 * Several things the export cannot carry are resolved here, deliberately:
 *
 * - **Site content is replaced, not merged.** Pages and tree entries are matched by path/locale with
 *   no natural merge order, and history rows are not matched to anything at all, so a restore is
 *   defined as putting the site back to exactly what the archive describes.
 * - **Pages, tree entries, assets and page-history rows get fresh ids, unlike groups.** Each of those
 *   id spaces is global rather than per-site, so reusing the archive's own ids would collide with the
 *   source site's rows whenever it still exists in the same database — restoring a backup beside the
 *   original, or duplicating one site's content into another, are ordinary uses of this. A page's or
 *   asset's tree entry shares its id, so the id is generated once per page/asset and carried through
 *   to the tree row; a navigation row keyed by one tree entry's id (`models/navigation.ts`), rather
 *   than the site-wide default menu, follows the same remap. `pageHistory.pageId` is remapped when
 *   its page is still in the archive and left as the archive's own (now-dangling) id otherwise,
 *   mirroring what it pointed at on the source instance, where it was never a foreign key either.
 * - **Groups are upserted by id, not replaced**, being global rather than site-scoped: wiping the
 *   table to restore one site's export would take every other site's access model with it.
 *   `exportSite` never includes an `isSystem` group, so this never touches Administrators/Users/Guests.
 * - **An imported group rule's `sites` is re-scoped to the target site.** `helpers/pageRules.ts` and
 *   `helpers/siteRules.ts` both fail a rule closed when the page's or site's id is not in that list,
 *   so rules still naming the *source* site would leave the imported content governed by nothing.
 *   Anything left naming neither a known site nor the rewritten target is reported back as
 *   `unresolvedRuleSites` rather than silently kept.
 * - **Authorship cannot travel with the content**, since accounts are not part of the export — every
 *   author/creator/owner column is rewritten to the account performing the import.
 * - **`site.json` is validated as present but not applied**: the target site's own config, hostname
 *   and enabled state are left untouched.
 * - **`tags` is not part of the archive at all.** Nothing in this codebase writes that table
 *   (`models/tags.ts` derives the tag list from `pages.tags` instead), so there is nothing to export,
 *   purge or rebuild.
 *
 * **Cache and index invalidation is deliberately not this method's job.** Writing the tables directly
 * rather than through each domain model means none of the ordinary post-write hooks (the page-rule
 * cache reload/broadcast, the glossary and asset path caches, the search index) fire as a side effect
 * of this transaction, and this model has no business scheduling a cross-instance broadcast or
 * queuing a reindex job. `tasks/simple/import-content.ts`, the sole caller, is where that happens,
 * once this has returned successfully.
 */
class ImportModel {
  get importsPath(): string {
    return path.resolve(CARDINAL.ROOTPATH, CARDINAL.config.dataPath, 'imports')
  }

  /**
   * Streams the upload straight to `<dataPath>/imports/` rather than buffering it: a whole archive
   * materialised as one `Buffer` in the request thread is what stands between a legitimate large
   * import and an OOM. `api/system/transfer.ts`'s content-type parser hands this the raw request
   * stream for that reason.
   *
   * `bodyLimit` has to be enforced here as bytes arrive, since a streamed body bypasses Fastify's own
   * automatic `Content-Length` check (that runs only for its `parseAs: 'buffer' | 'string'` parsers).
   * The gzip magic number is checked once the write has finished, there being no in-memory buffer to
   * check it against first. Any failure removes the partial file before rejecting.
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
   * Best-effort and idempotent: unlike an export's tarball, which is a downloadable product, an
   * upload is a working file and goes whether the import succeeded or failed.
   */
  async deleteUpload(filePath: string): Promise<void> {
    await fs.unlink(filePath).catch(() => {})
  }

  /**
   * Sweeps uploads whose job never ran to completion to clean up after itself (a crash mid-import).
   * Safe to call when the directory does not exist yet.
   */
  async purgeExpired(): Promise<number> {
    return purgeFilesOlderThan(this.importsPath, IMPORT_TTL_SECONDS)
  }

  async importSite(
    filePath: string,
    targetSiteId: string,
    importedById: string
  ): Promise<ImportResult> {
    const { entries, assetBlobs, stagingDir } = await readArchive(filePath)

    try {
      // -> Validated in full before a single query runs against the database: an archive this code
      //    does not recognize is refused outright, never restored best-effort.
      const manifest = readJson<{ formatVersion?: number; siteId?: string }>(
        entries,
        'manifest.json'
      )
      if (manifest.formatVersion !== EXPORT_FORMAT_VERSION) {
        throw new Error(
          `Unsupported import archive version ${manifest.formatVersion ?? '(none)'} — this instance can only restore version ${EXPORT_FORMAT_VERSION} archives.`
        )
      }
      // -> Presence check only: a site's own config/hostname/enabled state is not part of what an
      //    import restores.
      readJson<Record<string, any>>(entries, 'site.json')
      const pageRows = readJson<Record<string, any>[]>(entries, 'pages.json')
      const treeRows = readJson<Record<string, any>[]>(entries, 'tree.json')
      const pageHistoryRows = readJson<Record<string, any>[]>(entries, 'pageHistory.json')
      const navigationRows = readJson<Record<string, any>[]>(entries, 'navigation.json')
      const groupRows = readJson<Record<string, any>[]>(entries, 'groups.json')
      const assetManifest = readJson<Record<string, any>[]>(entries, 'assets/manifest.json')

      const targetSiteRows = await CARDINAL.db
        .select({ id: sitesTable.id })
        .from(sitesTable)
        .where(eq(sitesTable.id, targetSiteId))
        .limit(1)
      if (!targetSiteRows[0]) {
        throw new Error(`Target site ${targetSiteId} does not exist.`)
      }

      // -> Computed up front so a tree entry can take the same new id its page/asset just got.
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

      // FIXME: `Promise.all` reads every blob `readArchive` staged to disk back into memory at once,
      //        undoing that staging — read each chunk's blobs inside the insert loop below instead.
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

      // -> Computed up front, rather than inline in the `.map()` below, so a navigation row keyed by
      //    a tree entry's own id can resolve to the same new id, and so each tree row's own
      //    `navigationId` can be remapped alongside it.
      const treeIdMap = new Map<string, string>()
      for (const row of treeRows) {
        // -> A folder has no page/asset counterpart to stay in step with, so it gets an id of its own.
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
        treeIdMap.set(row.id, newId)
      }

      // -> A navigation row's id is either a tree entry's own (a per-entry override), in which case it
      //    follows that entry's new id, or unrelated to any tree row (the site-wide default menu).
      const navIdMap = new Map<string, string>(
        navigationRows.map((row) => [row.id, treeIdMap.get(row.id) ?? crypto.randomUUID()])
      )

      const mappedTreeRows = treeRows.map((row) => ({
        ...row,
        id: treeIdMap.get(row.id),
        siteId: targetSiteId,
        navigationId: row.navigationId ? (navIdMap.get(row.navigationId) ?? null) : null
      }))

      const mappedNavigationRows = navigationRows.map((row) => ({
        ...row,
        id: navIdMap.get(row.id),
        siteId: targetSiteId
      }))

      const mappedPageHistoryRows = pageHistoryRows.map((row) => ({
        ...row,
        // -> Fresh id: a same-instance restore runs alongside the source site's own history rows, which
        //    still hold the archive's original ids.
        id: crypto.randomUUID(),
        // -> A deleted page's history is exactly what makes recovering it possible, so a row with no
        //    page in the archive keeps the archive's own id, mirroring what it already pointed at on
        //    the source instance — `pageHistory.pageId` was never a foreign key there either.
        pageId: pageIdMap.get(row.pageId) ?? row.pageId,
        siteId: targetSiteId,
        authorId: importedById
      }))

      const knownSiteRows = await CARDINAL.db.select({ id: sitesTable.id }).from(sitesTable)
      const knownSiteIds = new Set(knownSiteRows.map((row) => row.id))

      const unresolvedRuleSites: UnresolvedRuleSite[] = []
      const mappedGroupRows = groupRows.map((group) => {
        const rules = (Array.isArray(group.rules) ? group.rules : []) as GroupRule[]
        const mappedRules = rules.map((rule) => {
          const sites = Array.isArray(rule.sites) ? rule.sites : []
          const mappedSites = sites.map((siteId) =>
            siteId === manifest.siteId ? targetSiteId : siteId
          )
          for (const siteId of mappedSites) {
            if (!knownSiteIds.has(siteId)) {
              unresolvedRuleSites.push({ groupId: group.id, ruleId: rule.id, siteId })
            }
          }
          return { ...rule, sites: mappedSites }
        })
        return { ...group, rules: mappedRules }
      })

      await CARDINAL.db.transaction(async (tx) => {
        await tx.delete(assetsTable).where(eq(assetsTable.siteId, targetSiteId))
        await tx.delete(treeTable).where(eq(treeTable.siteId, targetSiteId))
        await tx.delete(pagesTable).where(eq(pagesTable.siteId, targetSiteId))
        // -> `pageHistory.pageId` is not a foreign key (history outlives the page it describes), so
        //    nothing above cascaded this away — without an explicit purge a repeated restore
        //    accumulates orphaned rows forever.
        await tx.delete(pageHistoryTable).where(eq(pageHistoryTable.siteId, targetSiteId))
        await tx.delete(navigationTable).where(eq(navigationTable.siteId, targetSiteId))

        for (const group of mappedGroupRows) {
          await tx
            .insert(groupsTable)
            .values(group as any)
            .onConflictDoUpdate({ target: groupsTable.id, set: group as any })
        }

        for (const batch of chunk(mappedPageRows, PAGE_INSERT_CHUNK_SIZE)) {
          await tx.insert(pagesTable).values(batch as any)
        }

        // -> Navigation before tree: a tree row's `navigationId` (a per-entry override) is a foreign
        //    key into `navigation.id`, so the referenced row has to exist first.
        for (const batch of chunk(mappedNavigationRows, NAVIGATION_INSERT_CHUNK_SIZE)) {
          await tx.insert(navigationTable).values(batch as any)
        }

        for (const batch of chunk(mappedTreeRows, TREE_INSERT_CHUNK_SIZE)) {
          await tx.insert(treeTable).values(batch as any)
        }

        for (const batch of chunk(mappedAssetRows, ASSET_INSERT_CHUNK_SIZE)) {
          await tx.insert(assetsTable).values(batch as any)
        }

        for (const batch of chunk(mappedPageHistoryRows, PAGE_HISTORY_INSERT_CHUNK_SIZE)) {
          await tx.insert(pageHistoryTable).values(batch as any)
        }
      })

      return {
        pages: mappedPageRows.length,
        tree: mappedTreeRows.length,
        assets: mappedAssetRows.length,
        pageHistory: mappedPageHistoryRows.length,
        navigation: mappedNavigationRows.length,
        groups: groupRows.length,
        unresolvedRuleSites
      }
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

export const importModel = new ImportModel()
