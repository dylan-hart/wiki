/**
 * Local disk storage module — writes pages and assets out to a directory on the file system the
 * server itself can reach, can archive whatever currently sits there into a tar.gz, and can walk it
 * back in the other direction with `importAll()`.
 *
 * Unlike the `db` module, this one owns a real external destination: content written through
 * `dump()` lives at `<path>/<locale>/<folderPath>/<fileName>` for an asset, or
 * `<path>/<locale>/<page.path>.<ext>` for a page, entirely independent of the database rows the rest
 * of the app reads from. `validateConfig()` is what keeps that path from ever being something the
 * module cannot actually write to once a target is enabled.
 */
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

/**
 * File extension a dumped page is written with, keyed by its `contentType` — the shared table every
 * file-backed target writes pages under, with one deliberate override.
 */
const PAGE_EXTENSIONS: Record<string, string> = {
  ...CONTENT_TYPE_EXTENSIONS,
  // -> A redirection's `content` is already the JSON `RedirectContent` shape (see `models/pages.ts`),
  //    not prose, so it round-trips through a plain `.json` file rather than one of the editor
  //    extensions above. The only place this module diverges from the shared map (which writes a
  //    redirect as `.txt`, as `sftp` does).
  redirect: 'json'
}

/**
 * The page `contentType` an import-time extension maps back to, or `null` when the extension is not
 * one `dump()` ever writes a page under (i.e. this is an asset).
 *
 * `.md`/`.adoc`/`.html` reuse `models/storage.ts`'s shared `getContentTypeFromExtension` — the same
 * reverse mapping the git module reads its own remote changes back through — since those three mean
 * the same thing on disk as they do in a git working copy. `.json` is disk-specific (see
 * `PAGE_EXTENSIONS`'s `redirect` entry above): `getContentTypeFromExtension` knows nothing about it,
 * since no other file-backed module ever writes a redirect page as one.
 */
function pageContentTypeFromExtension(ext: string): string | null {
  if (ext === 'json') {
    return 'redirect'
  }
  return getContentTypeFromExtension(ext)
}

/** Extension a dumped page falls back to for a `contentType` not listed above. */
const DEFAULT_PAGE_EXTENSION = DEFAULT_CONTENT_TYPE_EXTENSION

/** The subfolder `backup()` writes manual archives into. */
const MANUAL_BACKUP_DIR = '_manual'

/** The subfolder `dailyBackup()` writes scheduled archives into. */
const DAILY_BACKUP_DIR = '_daily'

/**
 * Top-level entries `buildArchive()` never sweeps into the archive it is writing: the manual and
 * daily backup folders themselves. Without this, every backup would nest every backup before it,
 * growing without bound.
 */
const EXCLUDED_BACKUP_ENTRIES = new Set([MANUAL_BACKUP_DIR, DAILY_BACKUP_DIR])

/**
 * How long a `dailyBackup()` archive is kept before `pruneDailyBackups()` removes it — 30 days,
 * expressed in hours because `Temporal.Instant` arithmetic only accepts exact time units (no
 * calendar-relative `days`), and this codebase's convention is `{ hours: 24 }` per day for exactly
 * that reason.
 */
const DAILY_BACKUP_RETENTION_HOURS = 30 * 24

/**
 * `path` prop check beyond "is it a non-empty string" — the generic `validateConfig()` in
 * `models/storage.ts` has no filesystem access and cannot tell a config apart from one that will fail
 * the moment `dump()` tries to use it. Wired in as this module's `validateConfig` hook, which
 * `Storage.validateTarget()` calls whenever a target's config changes or it is being enabled — see
 * that method's doc for exactly when.
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

/** One page or asset to dump, as `listSiteEntries` reads it straight off the tree. */
interface SiteEntry {
  id: string
  type: 'page' | 'asset'
  locale: string
  folderPath: string
  fileName: string
}

/**
 * Every page and asset of a site, in a stable order — so that a `dump()` interrupted partway through
 * fails on the same entry (and has written the same entries before it) on every retry, which is what
 * makes rerunning it after a partial failure safe rather than merely likely to converge.
 *
 * Queried straight off the tree rather than through `WIKI.models.tree`'s `getTree()`, which caps
 * recursion at a folder depth meant for a UI listing (see `MAX_DEPTH` there) — a dump must not stop
 * partway down a deep folder tree.
 */
async function listSiteEntries(siteId: string): Promise<SiteEntry[]> {
  const rows = await WIKI.db
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

/** Writes `data` to `destPath`, creating whatever directories it needs first. */
async function writeUnderPath(destPath: string, data: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(destPath), { recursive: true })
  await fs.writeFile(destPath, data)
}

/**
 * `dump` ("Dump all content to disk"): write every page and asset of `target.siteId` under
 * `target.config.path`, mirroring the site's locale and folder structure — an asset lands at
 * `<path>/<locale>/<folderPath>/<fileName>`, a page at `<path>/<locale>/<page.path>.<ext>` (`ext` from
 * `PAGE_EXTENSIONS`). Directories are created as needed.
 *
 * **Deterministically overwrites, never skips.** Every entry is written unconditionally on every run:
 * the same page or asset always produces the same bytes at the same path, so writing it again is a
 * no-op in effect. That is what makes rerunning `dump()` after a partial failure safe — there is no
 * "already dumped" state to get out of sync, just entries not yet reached that get written this time
 * along with everything already on disk being written again over itself.
 *
 * A site with nothing to dump (no pages, no assets) simply writes nothing and resolves normally — see
 * `listSiteEntries` returning an empty list.
 *
 * Implements disk's always-prefixed serialization convention (every locale, including the primary,
 * gets its own directory) — see `docs/decisions/locale-architecture.md` §5.3.
 *
 * @throws With a message naming the entry and the underlying fs error, the moment any single write
 *         fails (e.g. the path became unwritable mid-run) — entries already written before that point
 *         stay on disk, and the ones after it are simply not attempted this run.
 */
export async function dump(target: StorageTarget): Promise<void> {
  const basePath = String(target.config.path ?? '')
  const entries = await listSiteEntries(target.siteId)

  for (const entry of entries) {
    try {
      if (entry.type === 'page') {
        const page = await WIKI.models.pages.getPage({
          siteId: target.siteId,
          id: entry.id,
          withContent: true
        })
        if (!page) {
          // -> Deleted between listing and dumping; nothing left to write for it
          continue
        }
        const ext = PAGE_EXTENSIONS[page.contentType] ?? DEFAULT_PAGE_EXTENSION
        const destPath = path.join(basePath, page.locale, `${page.path}.${ext}`)
        await writeUnderPath(destPath, page.content ?? '')
      } else {
        const content = await WIKI.models.assets.getContent(entry.id)
        if (!content) {
          // -> Deleted, or its bytes were purged (e.g. by the db module's `purge` action) between
          //    listing and dumping; nothing left to write for it
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

/** One entry `importAll()` could not place, alongside a human-readable reason. */
interface UnrecognizedEntry {
  /** `<locale>/<folderPath>/<fileName>`-shaped, relative to `target.config.path`. */
  path: string
  reason: string
}

/** What `importAll()` did, returned for a direct caller (e.g. a test) and written to the log. */
export interface ImportAllResult {
  /** New pages created. Does not include pages skipped because one already existed at the path. */
  pagesCreated: number
  /** Markdown files whose path already had a page — left untouched, per the conservative default. */
  pagesSkipped: number
  /** Assets written — a new upload, or an existing one overwritten per the site's conflict setting. */
  assetsWritten: number
  /** Assets left untouched because the site's `uploads.conflictBehavior` is `reject`, or the name was
   *  already taken by a page or a folder rather than another asset. */
  assetsSkipped: number
  /** Entries that are not something `dump()` would ever have produced, so nothing was imported for
   *  them — a dotfile, a top-level entry outside a configured locale, a symlink, a name the tree
   *  rejects, empty page content, and the like. Surfaced rather than silently dropped. */
  unrecognized: UnrecognizedEntry[]
}

/** Who `importAll()` writes pages and assets as, since it runs with no session behind it (see
 *  `Storage.executeAction()` / the `dispatchStorage` task, neither of which carry an actor). The
 *  wiki's own root admin, seeded at first run and guaranteed to exist — see `SystemIds.userAdminId`
 *  in `models/types.ts`. `manage:system` is what lets it write pages that carry scripts or styles
 *  without a real reviewer in the loop, the same bypass every other `manage:system` check gets. */
function importActor(): { id: string; groupIds: string[]; permissions: string[] } {
  return { id: WIKI.data.systemIds.userAdminId, groupIds: [], permissions: ['manage:system'] }
}

/**
 * Import one page file — markdown, asciidoc, HTML, or a redirect's JSON — at the path its position
 * in the tree implies and with the editor its `contentType` implies (`getEditorForContentType`,
 * `models/pages.ts`) — the inverse of `dump()`'s `<path>/<locale>/<page.path>.<ext>`, for whichever
 * `ext` its `contentType` maps to (`PAGE_EXTENSIONS` / `pageContentTypeFromExtension`).
 *
 * A path already holding a page (or anything else) is left alone: `pagesSkipped` is incremented
 * rather than the existing page touched, which is what makes re-running `importAll` after a partial
 * import safe — nothing already imported is ever revisited. Pages have no `conflictBehavior` setting
 * the way asset uploads do (see `importAsset`), so this is the conservative default this module picked
 * for them, documented here since there was nowhere else to put it.
 *
 * No `render` is sent — `createPage()` itself now recognizes that shape (content with no render) and
 * queues the same headless-browser re-render for it that a stored page's stale HTML gets, after
 * confirming up front that something here could actually produce one (OpenProject #1716/#1723). A wiki
 * with no Puppeteer extension installed therefore refuses the create rather than landing a page that
 * never gets a render; that failure surfaces to `importLocaleDir`'s own per-entry try/catch (below) as
 * an `unrecognized` entry, the same as any other import failure.
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

  const occupant = await WIKI.models.tree.getEntryAt({ siteId, locale, parentPath, fileName })
  if (occupant) {
    result.pagesSkipped++
    return
  }

  const content = await fs.readFile(filePath, 'utf8')
  const actor = importActor()
  await WIKI.models.pages.createPage(
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
 * Import one non-markdown file as an asset, in the folder its position in the tree implies — the
 * inverse of `dump()`'s `<path>/<locale>/<folderPath>/<fileName>`.
 *
 * Goes straight through `WIKI.models.assets.upload()` — the same extension → mimeType → `AssetKind`
 * detection a real upload gets, and the same collision handling: what happens to a name already taken
 * is the site's own `uploads.conflictBehavior` (`overwrite`, `reject` or `new` — see
 * `Assets.conflictBehaviorFor()`), not a rule this module invents. That does mean a target on a site
 * configured for `new` is not perfectly idempotent across reruns — a second `importAll` over a file
 * already imported produces a `-1` copy rather than being recognized as "already have this," the same
 * outcome uploading the same file twice through the UI would produce. `overwrite` (the default) and
 * `reject` are both safely idempotent: a rerun either writes the same bytes over themselves or is
 * turned away and counted in `assetsSkipped`, either way with nothing duplicated.
 *
 * A name already taken by a page or a folder, rather than another asset, is always turned away by
 * `upload()` regardless of `conflictBehavior` — also counted in `assetsSkipped`.
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
      const folder = await WIKI.models.tree.getFolder({
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
    await WIKI.models.assets.upload({
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
 * Walk one locale's folder recursively, importing every file it finds — a `.md`/`.adoc`/`.html`/
 * `.json` file as a page, in the content type its extension implies (see `importPage` and
 * `pageContentTypeFromExtension` — every extension `dump()` ever writes a page under, not just
 * `.md`), anything else as an asset (see `importAsset`). A dotfile (`.DS_Store` and the like — never
 * something `dump()` writes, and `sanitizeFileName` would silently rename it into a real asset rather
 * than refuse it) is reported in `unrecognized` instead of imported under a mangled name, and so is a
 * symlink, a device file, or anything else that is neither a plain file nor a directory. A single file
 * failing — an invalid page path, empty content, a folder name the tree rejects — is logged and
 * reported the same way rather than aborting the rest of the walk.
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
      WIKI.logger.warn('storage', 'importing a file failed', {
        module: 'disk',
        path: relPath,
        error: err
      })
    }
  }
}

/**
 * `importAll` ("Import Everything"): walk `target.config.path` and reconcile it against
 * `target.siteId`'s tree, creating whatever `dump()` would have written but is not there yet — the
 * inverse of `dump()`. A top-level entry is only ever descended into when it is a directory named
 * after one of the site's active locales (`WIKI.sites[siteId].config.locales.active`); anything else
 * — a stray file, a directory for a locale the site does not have configured — is reported in
 * `unrecognized` rather than guessed at, since there is no locale to file it under. The module's own
 * `_manual` and `_daily` backup folders are recognized and skipped without being reported: they are
 * something this module wrote, just not content.
 *
 * See `importPage` and `importAsset` for what happens to a path that already has something at it, and
 * `importLocaleDir` for how an unrecognized entry is decided within a locale.
 *
 * Nothing here is transactional across the whole run — each file is its own create-or-skip, so a run
 * interrupted partway through (the process restarting, a single bad file) leaves everything already
 * imported in place, and picks up the rest on the next run without redoing or duplicating what is
 * already there. Queued through the scheduler rather than run inline — see `SYNC_SHAPED_ACTIONS`.
 *
 * @throws Only when `target.config.path` itself cannot be read at all (e.g. it was removed after the
 *         target was enabled) — every failure *within* the tree is caught per-entry and reported in
 *         the returned result instead.
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

  const activeLocales = new Set<string>(WIKI.sites[target.siteId]?.config?.locales?.active ?? [])
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

  WIKI.logger.info('storage', 'import completed', {
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
 * Shared by `backup()` and `dailyBackup()`: tar.gz everything currently under `basePath` (excluding
 * both backup subfolders — see `EXCLUDED_BACKUP_ENTRIES`) into `<basePath>/<subDir>/<timestamp>.tar.gz`,
 * creating `subDir` if it does not exist yet.
 *
 * The archive is built from whatever is on disk right now, not from the database — it is a backup of
 * this target's own content, which is only ever as current as the last successful `dump()`. Unlike a
 * module that implements the write-path content handlers (`git`, `s3`, ...), this module has none —
 * see `StorageDefinition.supportsContentSync` — so nothing keeps this copy current between manual
 * `dump()` runs.
 *
 * @throws With a message naming the failing step (creating the subfolder, reading the directory, or
 *         writing the archive) and the underlying fs error, e.g. when the path became unwritable
 *         mid-run.
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

  // -> Colons are not valid in a Windows file name, and this module's own `path` prop hint offers a
  //    Windows example (`C:\wiki\backup`) as a supported destination, so the instant's own separators
  //    are swapped for dashes rather than assumed to be safe.
  const timestamp = Temporal.Now.instant().toString({ smallestUnit: 'second' }).replaceAll(':', '-')
  const archivePath = path.join(archiveDir, `${timestamp}.tar.gz`)

  try {
    await createTarball({ gzip: true, file: archivePath, cwd: basePath }, entries)
  } catch (err: any) {
    throw new Error(`Failed to write the backup archive to "${archivePath}": ${err.message}`)
  }

  return archivePath
}

/**
 * `backup` ("Create Backup"): tar.gz everything currently under `target.config.path` into
 * `<path>/_manual/<timestamp>.tar.gz`, creating the `_manual` subfolder if it does not exist yet. See
 * `buildArchive()` for the shared mechanics and its `@throws`.
 */
export async function backup(target: StorageTarget): Promise<void> {
  const basePath = String(target.config.path ?? '')
  await buildArchive(basePath, MANUAL_BACKUP_DIR)
}

/**
 * Remove every `.tar.gz` archive in `dailyDir` whose file `mtime` is `DAILY_BACKUP_RETENTION_HOURS`
 * (30 days) old or older — the "kept for a month" half of `createDailyBackups`'s `definition.yml`
 * hint. Compared against `mtime` rather than a timestamp parsed back out of the file name: `mtime` is
 * exactly what `buildArchive()` sets when it writes the file, needs no reverse-parsing of the
 * colon-to-dash-substituted name `backup()`/`dailyBackup()` produce, and native `Temporal` converts a
 * `Date` (what `fs.stat()` returns) directly via `.toTemporalInstant()`.
 *
 * A boundary archive — exactly `DAILY_BACKUP_RETENTION_HOURS` old — is pruned, not kept: retention is
 * "kept for a month", not "kept for over a month".
 *
 * A `dailyDir` that does not exist yet (no daily backup has ever run for this target) is treated as
 * having nothing to prune, not an error. Likewise, an entry that vanishes between being listed and
 * being stat'd or removed (e.g. pruned concurrently) is silently skipped rather than failing the run.
 *
 * @param now Defaults to the real current instant; overridable so tests can exercise the boundary
 *            without waiting 30 days or forging file mtimes.
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
 * `dailyBackup`: the scheduled counterpart to `backup()`, run by the `storageDailyBackup` system task
 * (see `tasks/simple/storage-daily-backup.ts`) for every enabled disk target with
 * `config.createDailyBackups` set. Archives into `<path>/_daily/<timestamp>.tar.gz` via the same
 * `buildArchive()` `backup()` uses, then prunes `_daily` entries older than a month via
 * `pruneDailyBackups()` — so retention is enforced right after every successful archive rather than
 * needing a separate scheduled pass.
 */
export async function dailyBackup(target: StorageTarget): Promise<void> {
  const basePath = String(target.config.path ?? '')
  await buildArchive(basePath, DAILY_BACKUP_DIR)
  await pruneDailyBackups(path.join(basePath, DAILY_BACKUP_DIR))
}

const diskStorageModule: StorageModule = {
  validateConfig,
  dump,
  importAll,
  backup,
  dailyBackup
}

export default diskStorageModule
