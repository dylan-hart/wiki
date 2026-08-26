import fs from 'node:fs/promises'
import path from 'node:path'
import { list as listTarball } from 'tar'
import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
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
import { EXPORT_FORMAT_VERSION } from './export.ts'

/** How long an uploaded import sits on disk before `purgeExpired` sweeps it, in seconds. */
const IMPORT_TTL_SECONDS = 24 * 60 * 60

/** One imported group rule whose `sites` still names a site id this instance cannot resolve, once the
 *  archive's own source site has already been rewritten to `targetSiteId` — see `importSite`. */
export interface UnresolvedRuleSite {
  groupId: string
  ruleId: string
  siteId: string
}

export interface ImportResult {
  pages: number
  tree: number
  assets: number
  pageHistory: number
  navigation: number
  groups: number
  unresolvedRuleSites: UnresolvedRuleSite[]
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
 */
async function readArchive(filePath: string): Promise<Record<string, Buffer>> {
  const entries: Record<string, Buffer> = {}
  await listTarball({
    file: filePath,
    onReadEntry: (entry) => {
      // -> `create()` (see `models/export.ts`) emits a directory entry for `assets/` itself, ahead of
      //    the files inside it -- nothing this reads back ever needs that entry, only the files.
      if (entry.type !== 'File') {
        return
      }
      const chunks: Buffer[] = []
      entry.on('data', (chunk) => chunks.push(chunk))
      entry.on('end', () => {
        entries[entry.path] = Buffer.concat(chunks)
      })
    }
  })
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
 * Several things the export cannot carry are resolved here, deliberately and not as a fallback for a
 * case that "shouldn't occur":
 *
 * - **Site content is replaced, not merged.** Every existing page, tree entry, asset and page-history
 *   row belonging to the target site is deleted before the imported ones are inserted. Pages and tree
 *   entries are matched by path/locale with no natural merge order, and history rows are not matched
 *   to anything at all, so "restore" is defined as putting the site back to exactly what the archive
 *   describes, not layering it on top of whatever is already there.
 * - **Pages, tree entries, assets and page-history rows get fresh ids, unlike groups.**
 *   `pages.id`/`tree.id`/`assets.id`/`pageHistory.id` are each one global primary-key space, not
 *   scoped per site, so re-using the archive's own ids would collide with the source site's rows the
 *   moment it still exists in the same database — restoring a backup while the original site is still
 *   around, or duplicating one site's content into another, are both ordinary uses of this, not edge
 *   cases. A page's and an asset's tree entry share its id (see below), so the new id is generated once
 *   per page/asset and carried through to its tree row rather than each row picking its own; a
 *   navigation row belonging to one specific tree entry (rather than the site-wide default menu) is the
 *   same story, keyed by that entry's own id (`models/navigation.ts`), so it follows the same remap.
 *   `pageHistory.pageId` is remapped through the same page id map when the page it belongs to still
 *   exists in the archive, and left as the archive's own (now-dangling) id otherwise — exactly mirroring
 *   what it already pointed at on the source instance, since it was never a foreign key there either.
 * - **Groups are upserted by id, not replaced.** Unlike pages/tree/assets/history, groups are global
 *   rather than site-scoped (see CLAUDE.md's Permissions section) — wiping the whole table to restore
 *   one site's export would take every other site's access model with it. An imported group updates one
 *   already on this instance when its id matches (the ordinary case: restoring a backup onto the same
 *   instance that produced it) or is inserted as a new one when it does not (importing onto a different
 *   instance). `exportSite` never includes an `isSystem` group in the first place (see `models/export.ts`),
 *   so this loop never touches Administrators/Users/Guests.
 * - **An imported group rule's `sites` is re-scoped to the target site.** A rule addresses sites by id
 *   (`GroupRule.sites`, see `models/groups.ts`), and the archive's rules still name the *source* site.
 *   Left unchanged, restoring onto a different site would leave the imported content governed by no
 *   rule at all — `helpers/pageRules.ts`/`helpers/siteRules.ts` both fail a rule closed when the page's
 *   or site's id is not in that list. Every occurrence of the archive's own `manifest.siteId` is
 *   rewritten to `targetSiteId`; anything left over that names neither a known site on this instance nor
 *   the just-rewritten target is reported back as `unresolvedRuleSites` rather than silently kept.
 * - **Authorship cannot travel with the content**, since accounts are not part of the export — every
 *   imported page's, asset's and page-history row's author/creator/owner columns are rewritten to the
 *   account performing the import.
 * - **The target site's own config, hostname and enabled state are left untouched.** `site.json` is
 *   validated as present (it is part of the archive's structure) but its contents are not applied —
 *   only pages, tree entries, page history, navigation, assets and groups are what this restores.
 * - **`tags` is not part of the archive at all.** The `tags` table is never written by any code path in
 *   this codebase (`models/tags.ts` derives the tag list from `pages.tags` on the fly instead), so there
 *   is nothing to export, nothing to purge on the target, and nothing to rebuild — see
 *   `docs/audit-2026-08-24/correctness-models.md` §15 for the table's own removal, tracked separately.
 */
class ImportModel {
  /** `<dataPath>/imports` — created on first use, same as the export/icon/asset caches. */
  get importsPath(): string {
    return path.resolve(WIKI.ROOTPATH, WIKI.config.dataPath, 'imports')
  }

  /**
   * Save an uploaded archive to `<dataPath>/imports/`, returning the path the queued job reads it
   * back from.
   */
  async saveUpload(data: Buffer): Promise<string> {
    await fs.mkdir(this.importsPath, { recursive: true })
    const filePath = path.join(this.importsPath, `${crypto.randomUUID()}.tar.gz`)
    await fs.writeFile(filePath, data)
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
   * @param targetSiteId The site pages/tree/history/navigation/assets are restored into. Must already
   *   exist.
   * @param importedById The account performing the import — every restored page's/asset's/history
   *   row's author/creator/owner columns are rewritten to this id, since accounts are not part of the
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
    const manifest = readJson<{ formatVersion?: number; siteId?: string }>(entries, 'manifest.json')
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
    const pageHistoryRows = readJson<Record<string, any>[]>(entries, 'pageHistory.json')
    const navigationRows = readJson<Record<string, any>[]>(entries, 'navigation.json')
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

    // -> Every tree row's new id, computed up front (rather than inline in the `.map()` below) so a
    //    navigation row keyed by a tree entry's own id (see the class-level doc comment) can resolve
    //    to the exact same new id its tree entry just got, and so each tree row's own `navigationId`
    //    can be remapped right alongside it.
    const treeIdMap = new Map<string, string>()
    for (const row of treeRows) {
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
      treeIdMap.set(row.id, newId)
    }

    // -> A navigation row's id is either a tree entry's own id (a per-entry override) or something
    //    unrelated to any tree row at all (the site-wide default menu) — see the class-level doc
    //    comment. The former follows its tree entry's new id; the latter gets a fresh one of its own.
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
      // -> Not every history row's page still exists in the archive (a deleted page's history is
      //    exactly what makes recovering it possible) — left as the archive's own id when there is no
      //    newly-inserted page to resolve to, mirroring what it already pointed at on the source
      //    instance, since `pageHistory.pageId` was never a foreign key there either.
      pageId: pageIdMap.get(row.pageId) ?? row.pageId,
      siteId: targetSiteId,
      authorId: importedById
    }))

    // -> Every site id known to this instance, for flagging a group rule's `sites` entry that names
    //    neither the just-rewritten target nor anything else this instance actually has — see below.
    const knownSiteRows = await WIKI.db.select({ id: sitesTable.id }).from(sitesTable)
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

    await WIKI.db.transaction(async (tx) => {
      // -> Site content is replaced outright — see the class-level doc comment. Deleted before
      //    anything is inserted, all scoped to the target site alone.
      await tx.delete(assetsTable).where(eq(assetsTable.siteId, targetSiteId))
      await tx.delete(treeTable).where(eq(treeTable.siteId, targetSiteId))
      await tx.delete(pagesTable).where(eq(pagesTable.siteId, targetSiteId))
      // -> `pageHistory.pageId` is not a foreign key (history outlives the page it describes), so
      //    nothing above already cascaded this away — it has to be purged explicitly, in the same
      //    transaction, or a repeated restore accumulates orphaned rows forever.
      await tx.delete(pageHistoryTable).where(eq(pageHistoryTable.siteId, targetSiteId))
      await tx.delete(navigationTable).where(eq(navigationTable.siteId, targetSiteId))

      // -> Groups are global, so they are upserted by id rather than replaced wholesale — see the
      //    class-level doc comment.
      for (const group of mappedGroupRows) {
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

      if (mappedPageHistoryRows.length > 0) {
        await tx.insert(pageHistoryTable).values(mappedPageHistoryRows as any)
      }

      if (mappedNavigationRows.length > 0) {
        await tx.insert(navigationTable).values(mappedNavigationRows as any)
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
  }
}

export const importModel = new ImportModel()
