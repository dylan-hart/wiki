import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { create as createTarball } from 'tar'
import { eq } from 'drizzle-orm'
import { purgeFilesOlderThan } from '../helpers/fsPurge.ts'
import {
  assets as assetsTable,
  groups as groupsTable,
  navigation as navigationTable,
  pageHistory as pageHistoryTable,
  pages as pagesTable,
  sites as sitesTable,
  tree as treeTable
} from '../db/schema.ts'

/** How long a finished export sits on disk before `purgeExpired` sweeps it, in seconds. */
const EXPORT_TTL_SECONDS = 24 * 60 * 60

/**
 * The archive format `exportSite` writes and `importModel.importSite` reads back — the shape of
 * `manifest.json` plus what each of the other entries means, not the running `wikiVersion`. Bumped
 * only when that shape changes; an import whose manifest names a different version is refused
 * outright rather than restored best-effort (see `models/import.ts`).
 *
 * Bumped to 2 for `pageHistory.json` and `navigation.json` joining the archive, and for `groups.json`
 * no longer carrying `isSystem` rows — see `exportSite`'s doc comment.
 */
export const EXPORT_FORMAT_VERSION = 2

export interface ExportResult {
  filePath: string
  fileSize: number
}

/**
 * Drop columns that are either regenerated from the rest of a row (`ts`) or only ever meaningful to
 * the instance that computed them (`searchContent`), rather than to what an import would need to
 * recreate the row.
 */
function stripDerived<T extends Record<string, any>>(row: T): Partial<T> {
  const { ts: _ts, searchContent: _searchContent, ...rest } = row as any
  return rest
}

/**
 * Content export model
 *
 * Serializes one site's pages, tree, page history, navigation, assets (bytea included) and the
 * (instance-wide) groups into a single gzipped tar archive under `<dataPath>/exports/`, for the
 * "Export content" system utility.
 *
 * `groups.json` omits every `isSystem` row (Administrators/Users/Guests) — an equivalent is already
 * seeded by the target instance's own `Groups.init()`, and restoring one by id would either overwrite
 * a different instance's real Users/Guests groups wholesale (`groupUserId`/`groupGuestId` are fixed
 * constants, not per-instance) or land as a confusing, non-privileged duplicate Administrators row (its
 * id is per-instance random, so it can never collide with — or replace — the real one). The 2.5.x
 * importer made the identical call, at `migration/importers/users-groups.ts`.
 *
 * Every entry is first written into a per-export staging directory under the OS temp dir, then `tar`'s
 * file-based `create()` archives the whole directory in one pass — the same approach
 * `modules/storage/disk/storage.ts`'s `buildArchive()` uses for its own backups. `node-tar`'s streaming
 * `Pack` only ever reads entries from real files on disk (it lstats each path itself), so there is no
 * way to hand it a JSON string or an asset `Buffer` directly without staging it first; the staging
 * directory is removed once the tarball is written, win or lose, and kept outside `<dataPath>/exports/`
 * so a leftover from a crashed run is never mistaken by `purgeExpired()` for one of its own `.tar.gz`
 * files. Queued as a background job (`tasks/simple/export-content.ts`) rather than run inline, since a
 * large site's worth of asset bytes is not something a request thread should be blocked on.
 */
class ExportModel {
  /** `<dataPath>/exports` — created on first use, same as the icon and asset caches. */
  get exportsPath(): string {
    return path.resolve(WIKI.ROOTPATH, WIKI.config.dataPath, 'exports')
  }

  /**
   * Build the tarball for one site.
   *
   * @returns The path it was written to and its final size, which the caller (`exportContent`'s task)
   *   records on the job's history row via `WIKI.models.jobs.setResult`.
   */
  async exportSite(siteId: string): Promise<ExportResult> {
    const siteRows = await WIKI.db
      .select()
      .from(sitesTable)
      .where(eq(sitesTable.id, siteId))
      .limit(1)
    const site = siteRows[0]
    if (!site) {
      throw new Error(`Site ${siteId} does not exist.`)
    }

    const [pageRows, treeRows, assetRows, pageHistoryRows, navigationRows, groupRows] =
      await Promise.all([
        WIKI.db.select().from(pagesTable).where(eq(pagesTable.siteId, siteId)),
        WIKI.db.select().from(treeTable).where(eq(treeTable.siteId, siteId)),
        WIKI.db.select().from(assetsTable).where(eq(assetsTable.siteId, siteId)),
        WIKI.db.select().from(pageHistoryTable).where(eq(pageHistoryTable.siteId, siteId)),
        WIKI.db.select().from(navigationTable).where(eq(navigationTable.siteId, siteId)),
        // -> Groups are global, not site-scoped (see CLAUDE.md's Permissions section) — a site's
        //    access model cannot be reconstructed from its own rows alone. `isSystem` rows
        //    (Administrators/Users/Guests, seeded by `models/groups.ts#init`) are excluded:
        //    `importSite` upserts groups by id, and the three behave differently on a *different*
        //    target instance -- Users/Guests sit at fixed cross-instance ids
        //    (`WIKI.data.systemIds`, `base.yml`), so restoring them overwrites that instance's own
        //    Users/Guests wholesale, while Administrators is per-instance random and would land as
        //    a non-privileged duplicate instead. The 2.5.x importer made the same call already
        //    (`migration/importers/users-groups.ts` -- "an equivalent is already seeded by this
        //    install's own `Groups.init()`").
        WIKI.db.select().from(groupsTable).where(eq(groupsTable.isSystem, false))
      ])

    await fs.mkdir(this.exportsPath, { recursive: true })
    const filePath = path.join(this.exportsPath, `${crypto.randomUUID()}.tar.gz`)
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-export-'))

    try {
      await fs.writeFile(
        path.join(stagingDir, 'manifest.json'),
        JSON.stringify(
          {
            formatVersion: EXPORT_FORMAT_VERSION,
            wikiVersion: WIKI.version,
            exportedAt: Temporal.Now.instant().toString({ smallestUnit: 'millisecond' }),
            siteId
          },
          null,
          2
        )
      )
      await fs.writeFile(
        path.join(stagingDir, 'site.json'),
        JSON.stringify(stripDerived(site), null, 2)
      )
      await fs.writeFile(
        path.join(stagingDir, 'pages.json'),
        JSON.stringify(pageRows.map(stripDerived), null, 2)
      )
      await fs.writeFile(
        path.join(stagingDir, 'tree.json'),
        JSON.stringify(treeRows.map(stripDerived), null, 2)
      )
      await fs.writeFile(
        path.join(stagingDir, 'pageHistory.json'),
        JSON.stringify(pageHistoryRows, null, 2)
      )
      await fs.writeFile(
        path.join(stagingDir, 'navigation.json'),
        JSON.stringify(navigationRows, null, 2)
      )
      await fs.writeFile(path.join(stagingDir, 'groups.json'), JSON.stringify(groupRows, null, 2))

      // -> Metadata and bytes travel separately: a JSON manifest of every asset's columns other than
      //    `data`/`preview`, plus one archive entry per asset per bytea column actually populated —
      //    writing a Buffer straight into a base64 JSON string would inflate it by a third for no
      //    reason the tar format doesn't already avoid.
      const assetsDir = path.join(stagingDir, 'assets')
      await fs.mkdir(assetsDir, { recursive: true })
      const assetManifest: Record<string, any>[] = []
      for (const asset of assetRows) {
        const { data, preview, ...meta } = asset
        assetManifest.push(meta)
        if (data) {
          await fs.writeFile(path.join(assetsDir, `${asset.id}.data`), data)
        }
        if (preview) {
          await fs.writeFile(path.join(assetsDir, `${asset.id}.preview`), preview)
        }
      }
      await fs.writeFile(
        path.join(assetsDir, 'manifest.json'),
        JSON.stringify(assetManifest, null, 2)
      )

      const stagedEntries = await fs.readdir(stagingDir)
      await createTarball({ gzip: true, file: filePath, cwd: stagingDir }, stagedEntries)
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true })
    }

    const { size } = await fs.stat(filePath)
    return { filePath, fileSize: size }
  }

  /**
   * Delete one export file. Best-effort and idempotent — called once a download has finished
   * streaming, and safe to call again on a file `purgeExpired` already swept.
   */
  async deleteExport(filePath: string): Promise<void> {
    await fs.unlink(filePath).catch(() => {})
  }

  /**
   * Sweep `<dataPath>/exports/` of anything older than the TTL — the export nobody came back to
   * download. Safe to call when the directory does not exist yet (nothing has ever been exported).
   *
   * @returns How many files were removed
   */
  async purgeExpired(): Promise<number> {
    return purgeFilesOlderThan(this.exportsPath, EXPORT_TTL_SECONDS)
  }
}

export const exportModel = new ExportModel()
