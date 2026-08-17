/**
 * Local disk storage module — writes pages and assets out to a directory on the file system the
 * server itself can reach, and can archive whatever currently sits there into a tar.gz.
 *
 * Unlike the `db` module, this one owns a real external destination: content written through
 * `dump()` lives at `<path>/<locale>/<folderPath>/<fileName>` for an asset, or
 * `<path>/<locale>/<page.path>.<ext>` for a page, entirely independent of the database rows the rest
 * of the app reads from. `validateConfig()` is what keeps that path from ever being something the
 * module cannot actually write to once a target is enabled.
 */
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { asc, and, eq, inArray } from 'drizzle-orm'
import { create as createTarball } from 'tar'
import { decodeTreePath } from '../../../helpers/common.ts'
import { tree as treeTable } from '../../../db/schema.ts'
import type { StorageModule, StorageTarget } from '../../../models/storage.ts'

/** File extension a dumped page is written with, keyed by its `contentType`. */
const PAGE_EXTENSIONS: Record<string, string> = {
  markdown: 'md',
  asciidoc: 'adoc',
  html: 'html',
  // -> A redirection's `content` is already the JSON `RedirectContent` shape (see `models/pages.ts`),
  //    not prose, so it round-trips through a plain `.json` file rather than one of the editor
  //    extensions above.
  redirect: 'json'
}

/** Extension a dumped page falls back to for a `contentType` not listed above. */
const DEFAULT_PAGE_EXTENSION = 'txt'

/** The subfolder `backup()` writes manual archives into. */
const MANUAL_BACKUP_DIR = '_manual'

/**
 * Top-level entries `backup()` never sweeps into the archive it is writing: its own output folder,
 * and the daily-backup folder `createDailyBackups` will write into once that scheduled feature
 * exists. Without this, every backup would nest every backup before it, growing without bound.
 */
const EXCLUDED_BACKUP_ENTRIES = new Set([MANUAL_BACKUP_DIR, '_daily'])

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

/**
 * `backup` ("Create Backup"): tar.gz everything currently under `target.config.path` into
 * `<path>/_manual/<timestamp>.tar.gz`, creating the `_manual` subfolder if it does not exist yet.
 *
 * The archive is built from whatever is on disk right now, not from the database — it is a backup of
 * this target's own content, which is only ever as current as the last successful `dump()` (or the
 * write-path syncs that keep landing here on every page/asset change). `_manual` itself, and `_daily`
 * (the not-yet-implemented scheduled counterpart declared by `createDailyBackups` in
 * `definition.yml`), are excluded from the archive's contents — see `EXCLUDED_BACKUP_ENTRIES` for why.
 *
 * @throws With a message naming the failing step (reading the directory, or writing the archive) and
 *         the underlying fs error, e.g. when the path became unwritable mid-run.
 */
export async function backup(target: StorageTarget): Promise<void> {
  const basePath = String(target.config.path ?? '')
  const manualDir = path.join(basePath, MANUAL_BACKUP_DIR)

  try {
    await fs.mkdir(manualDir, { recursive: true })
  } catch (err: any) {
    throw new Error(`Failed to create "${manualDir}" for the backup: ${err.message}`)
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
  const archivePath = path.join(manualDir, `${timestamp}.tar.gz`)

  try {
    await createTarball({ gzip: true, file: archivePath, cwd: basePath }, entries)
  } catch (err: any) {
    throw new Error(`Failed to write the backup archive to "${archivePath}": ${err.message}`)
  }
}

const diskStorageModule: StorageModule = {
  validateConfig,
  dump,
  backup
}

export default diskStorageModule
