import type { Dirent } from 'node:fs'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { startCase } from 'es-toolkit/string'
import { asc, and, eq, inArray } from 'drizzle-orm'
import { create as createTarball } from 'tar'
import { CustomError, decodeTreePath, normalizePagePath } from '../../../helpers/common.ts'
import {
  CONTENT_TYPE_EXTENSIONS,
  DEFAULT_CONTENT_TYPE_EXTENSION
} from '../../../helpers/pageSerialization.ts'
import { tree as treeTable } from '../../../db/schema.ts'
import { getContentTypeFromExtension } from '../../../models/storage.ts'
import { getEditorForContentType } from '../../../models/pages.ts'
import type { StorageModule, StorageTarget } from '../../../models/storage.ts'

const PAGE_EXTENSIONS: Record<string, string> = {
  ...CONTENT_TYPE_EXTENSIONS,
  // -> A redirection's `content` is already the JSON `RedirectContent` shape, not prose, so it
  //    round-trips as `.json`. The one place this module diverges from the shared map, which writes
  //    a redirect as `.txt`.
  redirect: 'json'
}

/**
 * `.json` is handled here rather than by the shared `getContentTypeFromExtension`, which knows
 * nothing about it: no other file-backed module writes a redirect page as one. `null` means the
 * extension is not one `dump()` writes pages under, so the file is an asset.
 */
function pageContentTypeFromExtension(ext: string): string | null {
  if (ext === 'json') {
    return 'redirect'
  }
  return getContentTypeFromExtension(ext)
}

const DEFAULT_PAGE_EXTENSION = DEFAULT_CONTENT_TYPE_EXTENSION

const MANUAL_BACKUP_DIR = '_manual'

const DAILY_BACKUP_DIR = '_daily'

/** Kept out of every archive: otherwise each backup would nest every backup before it. */
const EXCLUDED_BACKUP_ENTRIES = new Set([MANUAL_BACKUP_DIR, DAILY_BACKUP_DIR])

/** 30 days, in hours: `Temporal.Instant` arithmetic accepts exact time units only, never `days`. */
const DAILY_BACKUP_RETENTION_HOURS = 30 * 24

/**
 * The generic `validateConfig()` in `models/storage.ts` has no filesystem access, so it cannot tell a
 * well-formed `path` apart from one `dump()` will fail on the moment it is used.
 *
 * @returns The reason it is invalid, or null when it is fine
 */
export async function validateConfig(config: Record<string, any>): Promise<string | null> {
  const targetPath = typeof config.path === 'string' ? config.path.trim() : ''
  if (!targetPath) {
    return 'A path is required.'
  }
  if (!path.isAbsolute(targetPath)) {
    return `"${targetPath}" is not an absolute path.`
  }
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(targetPath)
  } catch {
    return `"${targetPath}" does not exist.`
  }
  if (!stat.isDirectory()) {
    return `"${targetPath}" is not a directory.`
  }
  try {
    await fs.access(targetPath, fsConstants.W_OK)
  } catch {
    return `"${targetPath}" is not writable.`
  }
  return null
}

interface SiteEntry {
  id: string
  type: 'page' | 'asset'
  locale: string
  folderPath: string
  fileName: string
}

/**
 * The order is stable so that an interrupted `dump()` fails on the same entry, having written the
 * same entries before it, on every retry — which is what makes a rerun after a partial failure safe
 * rather than merely likely to converge. Queried straight off the tree rather than through
 * `models/tree.ts`'s `getTree()`, whose `MAX_DEPTH` cap is sized for a UI listing and would stop a
 * dump partway down a deep folder tree.
 */
async function listSiteEntries(siteId: string): Promise<SiteEntry[]> {
  const rows = await CARDINAL.db
    .select({
      id: treeTable.id,
      type: treeTable.type,
      locale: treeTable.locale,
      folderPath: treeTable.folderPath,
      fileName: treeTable.fileName
    })
    .from(treeTable)
    .where(and(eq(treeTable.siteId, siteId), inArray(treeTable.type, ['page', 'asset'])))
    .orderBy(asc(treeTable.folderPath), asc(treeTable.fileName))

  return rows.map((row) => ({
    id: row.id,
    type: row.type as 'page' | 'asset',
    locale: row.locale,
    folderPath: decodeTreePath(row.folderPath ?? '') ?? '',
    fileName: row.fileName
  }))
}

async function writeUnderPath(destPath: string, data: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(destPath), { recursive: true })
  await fs.writeFile(destPath, data)
}

/**
 * Every locale gets its own directory, the primary included, per the locale-architecture decision's
 * §5.3.
 *
 * Every entry is written unconditionally on every run: the same page or asset always produces the
 * same bytes at the same path, so there is no "already dumped" state to get out of sync and a rerun
 * after a partial failure is safe.
 *
 * @throws The moment any single write fails; entries written before that point stay on disk, and the
 *         ones after it are not attempted this run.
 */
export async function dump(target: StorageTarget): Promise<void> {
  const basePath = String(target.config.path ?? '')
  const entries = await listSiteEntries(target.siteId)

  for (const entry of entries) {
    try {
      if (entry.type === 'page') {
        const page = await CARDINAL.models.pages.getPage({
          siteId: target.siteId,
          id: entry.id,
          withContent: true
        })
        if (!page) {
          // -> Deleted between listing and dumping
          continue
        }
        const ext = PAGE_EXTENSIONS[page.contentType] ?? DEFAULT_PAGE_EXTENSION
        const destPath = path.join(basePath, page.locale, `${page.path}.${ext}`)
        await writeUnderPath(destPath, page.content ?? '')
      } else {
        const content = await CARDINAL.models.assets.getContent(entry.id)
        if (!content) {
          // -> Deleted, or its bytes purged (the db module's `purge` action), between listing and
          //    dumping
          continue
        }
        const destPath = path.join(basePath, entry.locale, entry.folderPath, content.fileName)
        await writeUnderPath(destPath, content.data)
      }
    } catch (err: any) {
      throw new Error(
        `Failed to dump ${entry.type} "${entry.fileName}" (${entry.id}) to "${basePath}": ${err.message}`
      )
    }
  }
}

interface UnrecognizedEntry {
  /** `<locale>/<folderPath>/<fileName>`-shaped, relative to `target.config.path`. */
  path: string
  reason: string
}

export interface ImportAllResult {
  pagesCreated: number
  pagesSkipped: number
  assetsWritten: number
  /** Left untouched: `uploads.conflictBehavior` is `reject`, or a page or folder holds the name. */
  assetsSkipped: number
  /** Entries `dump()` would never have written — a dotfile, a stray top-level entry, a symlink, a
   *  name the tree rejects. Surfaced rather than silently dropped. */
  unrecognized: UnrecognizedEntry[]
}

/** `importAll()` runs with no session behind it, so it writes as the seeded root admin.
 *  `manage:system` is what lets it write pages carrying scripts or styles with no reviewer. */
function importActor(): { id: string; groupIds: string[]; permissions: string[] } {
  return { id: CARDINAL.data.systemIds.userAdminId, groupIds: [], permissions: ['manage:system'] }
}

/**
 * A path already holding anything is left alone rather than overwritten: pages have no
 * `conflictBehavior` setting the way asset uploads do (see `importAsset`), so this is the
 * conservative default chosen for them, and it is what makes re-running `importAll` after a partial
 * import safe.
 *
 * No `render` is sent: `createPage()` recognizes that shape and queues the re-render itself, after
 * confirming something can actually produce one — so a wiki with no Puppeteer extension refuses the
 * create rather than landing a page that never gets rendered.
 */
async function importPage(
  filePath: string,
  siteId: string,
  locale: string,
  pathSegments: string[],
  contentType: string,
  result: ImportAllResult
): Promise<void> {
  const pagePath = normalizePagePath(pathSegments.join('/'))
  const parts = pagePath.split('/')
  const fileName = parts.at(-1)!
  const parentPath = parts.slice(0, -1).join('/')

  const occupant = await CARDINAL.models.tree.getEntryAt({ siteId, locale, parentPath, fileName })
  if (occupant) {
    result.pagesSkipped++
    return
  }

  const content = await fs.readFile(filePath, 'utf8')
  const actor = importActor()
  await CARDINAL.models.pages.createPage(
    siteId,
    {
      path: pagePath,
      title: startCase(fileName),
      editor: getEditorForContentType(contentType),
      content,
      locale
    },
    actor
  )
  result.pagesCreated++
}

/**
 * A name already taken is handled by the site's own `uploads.conflictBehavior`, not a rule this
 * module invents. So a site configured for `new` is not idempotent across reruns — a second
 * `importAll` over an already-imported file produces a `-1` copy — while `overwrite` and `reject`
 * both are. A name held by a page or a folder rather than an asset is always refused by `upload()`,
 * whatever the setting.
 */
async function importAsset(
  filePath: string,
  siteId: string,
  locale: string,
  folderSegments: string[],
  fileName: string,
  folderIds: Map<string, string>,
  result: ImportAllResult
): Promise<void> {
  const folderPath = folderSegments.join('/')
  let folderId: string | undefined
  if (folderPath) {
    // -> Keyed by locale as well as path: two locales can each have their own "images" folder, and a
    //    bare `folderPath` key would hand the second locale's upload the first locale's folder id.
    const cacheKey = `${locale}/${folderPath}`
    folderId = folderIds.get(cacheKey)
    if (!folderId) {
      const folder = await CARDINAL.models.tree.getFolder({
        path: folderPath,
        locale,
        siteId,
        createIfMissing: true
      })
      folderId = folder.id
      folderIds.set(cacheKey, folderId)
    }
  }

  const data = await fs.readFile(filePath)
  const actor = importActor()
  try {
    await CARDINAL.models.assets.upload({
      siteId,
      locale,
      folderId,
      fileName,
      data,
      authorId: actor.id
    })
    result.assetsWritten++
  } catch (err: any) {
    if (
      err instanceof CustomError &&
      (err.name === 'assetAlreadyExists' || err.name === 'assetNameTakenByEntry')
    ) {
      result.assetsSkipped++
      return
    }
    throw err
  }
}

/**
 * A dotfile is reported in `unrecognized` rather than imported: `dump()` never writes one, and
 * `sanitizeFileName` would silently rename it into a real asset rather than refuse it. A single file
 * failing is reported the same way rather than aborting the rest of the walk.
 */
async function importLocaleDir(
  dir: string,
  siteId: string,
  locale: string,
  folderIds: Map<string, string>,
  result: ImportAllResult,
  segments: string[] = []
): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (err: any) {
    result.unrecognized.push({
      path: [locale, ...segments].join('/'),
      reason: `Could not read this folder: ${err.message}`
    })
    return
  }

  for (const entry of entries) {
    const relPath = [locale, ...segments, entry.name].join('/')

    if (entry.name.startsWith('.')) {
      result.unrecognized.push({ path: relPath, reason: 'Hidden file or folder.' })
      continue
    }
    if (entry.isDirectory()) {
      await importLocaleDir(path.join(dir, entry.name), siteId, locale, folderIds, result, [
        ...segments,
        entry.name
      ])
      continue
    }
    if (!entry.isFile()) {
      result.unrecognized.push({ path: relPath, reason: 'Not a regular file or folder.' })
      continue
    }

    const filePath = path.join(dir, entry.name)
    const ext = path.extname(entry.name).slice(1).toLowerCase()
    const contentType = pageContentTypeFromExtension(ext)
    try {
      if (contentType) {
        const baseName = entry.name.slice(0, entry.name.length - ext.length - 1)
        await importPage(filePath, siteId, locale, [...segments, baseName], contentType, result)
      } else {
        await importAsset(filePath, siteId, locale, segments, entry.name, folderIds, result)
      }
    } catch (err: any) {
      result.unrecognized.push({ path: relPath, reason: err.message })
      CARDINAL.logger.warn('storage', 'importing a file failed', {
        module: 'disk',
        path: relPath,
        error: err
      })
    }
  }
}

/**
 * The inverse of `dump()`. Only a top-level directory named after one of the site's active locales is
 * descended into: anything else has no locale to file its contents under, so it is reported in
 * `unrecognized` rather than guessed at. The module's own `_manual`/`_daily` folders are skipped
 * without being reported — this module wrote them, they are just not content.
 *
 * Nothing is transactional across the run: each file is its own create-or-skip, so an interrupted run
 * leaves what it imported in place and picks up the rest next time without duplicating anything.
 *
 * @throws Only when `target.config.path` itself cannot be read at all — every failure *within* the
 *         tree is caught per-entry and reported in the returned result instead.
 */
export async function importAll(target: StorageTarget): Promise<ImportAllResult> {
  const basePath = String(target.config.path ?? '')
  const result: ImportAllResult = {
    pagesCreated: 0,
    pagesSkipped: 0,
    assetsWritten: 0,
    assetsSkipped: 0,
    unrecognized: []
  }

  let topEntries: Dirent[]
  try {
    topEntries = await fs.readdir(basePath, { withFileTypes: true })
  } catch (err: any) {
    throw new Error(`Failed to read "${basePath}" to import: ${err.message}`)
  }

  const activeLocales = new Set<string>(
    CARDINAL.sites[target.siteId]?.config?.locales?.active ?? []
  )
  const folderIds = new Map<string, string>()

  for (const entry of topEntries) {
    if (EXCLUDED_BACKUP_ENTRIES.has(entry.name)) {
      continue
    }
    if (!entry.isDirectory() || !activeLocales.has(entry.name)) {
      result.unrecognized.push({
        path: entry.name,
        reason: entry.isDirectory()
          ? `"${entry.name}" is not one of this site's active locales.`
          : 'Not a locale folder.'
      })
      continue
    }
    await importLocaleDir(
      path.join(basePath, entry.name),
      target.siteId,
      entry.name,
      folderIds,
      result
    )
  }

  CARDINAL.logger.info('storage', 'import completed', {
    module: 'disk',
    target: target.id,
    pagesCreated: result.pagesCreated,
    pagesSkipped: result.pagesSkipped,
    assetsWritten: result.assetsWritten,
    assetsSkipped: result.assetsSkipped,
    unrecognized: result.unrecognized.length
  })
  return result
}

/**
 * The archive is built from whatever is on disk right now, not from the database, so it is only ever
 * as current as the last successful `dump()`: this module implements none of the write-path content
 * handlers (`supportsContentSync` is false), so nothing keeps the on-disk copy current between runs.
 */
async function buildArchive(basePath: string, subDir: string): Promise<string> {
  const archiveDir = path.join(basePath, subDir)

  try {
    await fs.mkdir(archiveDir, { recursive: true })
  } catch (err: any) {
    throw new Error(`Failed to create "${archiveDir}" for the backup: ${err.message}`)
  }

  let entries: string[]
  try {
    entries = (await fs.readdir(basePath)).filter((name) => !EXCLUDED_BACKUP_ENTRIES.has(name))
  } catch (err: any) {
    throw new Error(`Failed to read "${basePath}" for the backup: ${err.message}`)
  }

  // -> Colons are not valid in a Windows file name, and the `path` prop hint offers a Windows
  //    destination, so the instant's separators are swapped for dashes.
  const timestamp = Temporal.Now.instant().toString({ smallestUnit: 'second' }).replaceAll(':', '-')
  const archivePath = path.join(archiveDir, `${timestamp}.tar.gz`)

  try {
    await createTarball({ gzip: true, file: archivePath, cwd: basePath }, entries)
  } catch (err: any) {
    throw new Error(`Failed to write the backup archive to "${archivePath}": ${err.message}`)
  }

  return archivePath
}

export async function backup(target: StorageTarget): Promise<void> {
  const basePath = String(target.config.path ?? '')
  await buildArchive(basePath, MANUAL_BACKUP_DIR)
}

/**
 * Age is read from the file's `mtime` rather than a timestamp parsed back out of its name: `mtime` is
 * what writing the archive sets, and the name has had its colons substituted (see `buildArchive`).
 * An archive exactly at the boundary is pruned — retention is "kept for a month", not "kept for over
 * a month". A `dailyDir` that does not exist yet, and an entry that vanishes mid-run, are both
 * nothing to prune rather than errors.
 *
 * @param now Overridable so tests can exercise the boundary without waiting 30 days.
 */
export async function pruneDailyBackups(
  dailyDir: string,
  now: Temporal.Instant = Temporal.Now.instant()
): Promise<void> {
  let entries: string[]
  try {
    entries = await fs.readdir(dailyDir)
  } catch {
    return
  }

  const cutoff = now.subtract({ hours: DAILY_BACKUP_RETENTION_HOURS })

  for (const name of entries) {
    if (!name.endsWith('.tar.gz')) {
      continue
    }
    const entryPath = path.join(dailyDir, name)
    let mtime: Temporal.Instant
    try {
      mtime = (await fs.stat(entryPath)).mtime.toTemporalInstant()
    } catch {
      continue
    }
    if (Temporal.Instant.compare(mtime, cutoff) <= 0) {
      await fs.rm(entryPath, { force: true }).catch(() => {})
    }
  }
}

/**
 * Run by the `storageDailyBackup` system task for every enabled disk target with
 * `config.createDailyBackups` set. Retention is enforced right after each successful archive rather
 * than by a scheduled pass of its own.
 */
export async function dailyBackup(target: StorageTarget): Promise<void> {
  const basePath = String(target.config.path ?? '')
  await buildArchive(basePath, DAILY_BACKUP_DIR)
  await pruneDailyBackups(path.join(basePath, DAILY_BACKUP_DIR))
}

// -> No `assetRenamed`/`assetMoved` handler: this module writes out on demand rather than reacting to
//    individual write-path events (`supportsContentSync` is false for it), so a rename or a folder
//    move is picked up whole by the next `dump()` rather than propagated incrementally.
const diskStorageModule: StorageModule = {
  validateConfig,
  dump,
  importAll,
  backup,
  dailyBackup
}

export default diskStorageModule
