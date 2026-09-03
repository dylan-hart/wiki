import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { create as createTarball } from 'tar'
import { purgeFilesOlderThan } from '../helpers/fsPurge.ts'
import {
  assets as assetsTable,
  classificationLevels as classificationLevelsTable,
  comments as commentsTable,
  groups as groupsTable,
  navigation as navigationTable,
  pageHistory as pageHistoryTable,
  pages as pagesTable,
  settings as settingsTable,
  sites as sitesTable,
  tree as treeTable,
  userGroups as userGroupsTable,
  users as usersTable
} from '../db/schema.ts'

/** How long a finished snapshot sits on disk before `purgeExpired` sweeps it, in seconds. */
const REPLICATION_EXPORT_TTL_SECONDS = 24 * 60 * 60

/**
 * The archive format `buildSnapshot` writes — the shape of `manifest.json` plus what each of the
 * other entries means, not the running `wikiVersion`. Bumped only when that shape changes; a target
 * instance whose importer (#2490) does not recognize a manifest's `formatVersion` refuses it outright
 * rather than restoring best-effort, the same contract `models/export.ts#EXPORT_FORMAT_VERSION`
 * documents for the unrelated per-site archive.
 */
export const REPLICATION_EXPORT_FORMAT_VERSION = 1

export interface ReplicationExportResult {
  filePath: string
  fileSize: number
}

/**
 * Drop columns that are either regenerated from the rest of a row (`ts`) or only ever meaningful to
 * the instance that computed them (`searchContent`), rather than to what an import would need to
 * recreate the row. Mirrors `models/export.ts`'s own `stripDerived` — kept as a separate copy rather
 * than a shared export since the two archive formats are independent contracts that happen to strip
 * the same two columns today, not one that must always agree with the other.
 */
function stripDerived<T extends Record<string, any>>(row: T): Partial<T> {
  const { ts: _ts, searchContent: _searchContent, ...rest } = row as any
  return rest
}

/**
 * Instance-wide replication export model (source side of Epic #2437's scheduled clean-slate
 * replication)
 *
 * Serializes the ENTIRE instance — every site, not one — into a single gzipped tar archive under
 * `<dataPath>/exports/`: sites, classification levels, settings, groups, users and their group
 * memberships, pages/tree/page history/navigation/comments across every site, and every asset
 * (bytea included). This is deliberately a different surface from `models/export.ts#exportSite`,
 * which serializes one site's content for the existing "Export content" system utility and has its
 * own format version and importer contract (`models/import.ts`) — this model exists for Feature
 * #2437's full-parity instance mirror instead, resolved to need "a new bulk-export/import API
 * surface (not iterating the existing per-resource REST API)".
 *
 * Two deliberate divergences from `exportSite`'s choices, both because this is a whole-instance
 * wipe-and-replace rather than a restore layered onto an otherwise-live target:
 *
 * - `groups.json` INCLUDES `isSystem` rows (Administrators/Users/Guests). `exportSite` excludes
 *   them because its target site still has its own already-seeded system groups to collide with;
 *   here the target instance's entire database is wiped before the snapshot is restored (WP #2490),
 *   so there is nothing for these rows to collide with — omitting them would instead leave the
 *   mirrored instance without a working Administrators group at all.
 * - `settings.json` is included at all. A per-site export has no instance-wide settings to carry;
 *   a full-parity mirror does, by definition, and that can include sensitive values (mail/storage
 *   credentials, the auth secret, …). This is acceptable because the route this model backs
 *   (`api/system/replicationExport.ts`) is `manage:system`-only, exactly as sensitive as `GET
 *   /_api/system/settings` already is — not a new exposure this model introduces on its own.
 *
 * Every entry is first written into a per-export staging directory under the OS temp dir, then
 * `tar`'s file-based `create()` archives the whole directory in one pass, the same approach
 * `exportSite` and `modules/storage/disk/storage.ts#buildArchive()` both already use — `node-tar`'s
 * streaming `Pack` only ever reads entries from real files on disk, so there is no way to hand it a
 * JSON string or an asset `Buffer` directly without staging it first. The staging directory is
 * removed once the tarball is written, win or lose, and kept outside `<dataPath>/exports/` so a
 * leftover from a crashed run is never mistaken by `purgeExpired()` for one of its own `.tar.gz`
 * files. Queued as a background job (`tasks/simple/export-replication.ts`) rather than run inline,
 * since a whole instance's worth of asset bytes is not something a request thread should be blocked
 * on — see `api/system/replicationExport.ts`.
 *
 * No streaming/pagination for very large instances: every table in scope is read into memory in one
 * `select()` before being staged to disk, same ceiling `exportSite` already accepts for a single
 * site. Left as a known scaling follow-up rather than solved here — see this work package's own
 * notes on OpenProject #2489.
 */
class ReplicationExportModel {
  /** `<dataPath>/exports` — shared with `models/export.ts`'s per-site archives; both are swept by
   *  the same TTL policy and neither cares which produced a given file. */
  get exportsPath(): string {
    return path.resolve(WIKI.ROOTPATH, WIKI.config.dataPath, 'exports')
  }

  /**
   * Build the whole-instance snapshot tarball.
   *
   * @returns The path it was written to and its final size, which the caller
   *   (`tasks/simple/export-replication.ts`) records on the job's history row via
   *   `WIKI.models.jobs.setResult`.
   */
  async buildSnapshot(): Promise<ReplicationExportResult> {
    const [
      siteRows,
      classificationLevelRows,
      settingsRows,
      groupRows,
      userRows,
      userGroupRows,
      pageRows,
      treeRows,
      pageHistoryRows,
      navigationRows,
      commentRows
    ] = await Promise.all([
      WIKI.db.select().from(sitesTable),
      WIKI.db.select().from(classificationLevelsTable),
      WIKI.db.select().from(settingsTable),
      WIKI.db.select().from(groupsTable),
      WIKI.db.select().from(usersTable),
      WIKI.db.select().from(userGroupsTable),
      WIKI.db.select().from(pagesTable),
      WIKI.db.select().from(treeTable),
      WIKI.db.select().from(pageHistoryTable),
      WIKI.db.select().from(navigationTable),
      WIKI.db.select().from(commentsTable)
    ])
    // -> Assets travel separately below (their bytea columns need their own staged files), but the
    //    row set itself is fetched here alongside everything else for the same reason: one snapshot,
    //    one point-in-time read of the whole instance.
    const assetRows = await WIKI.db.select().from(assetsTable)

    await fs.mkdir(this.exportsPath, { recursive: true })
    const filePath = path.join(this.exportsPath, `${crypto.randomUUID()}.tar.gz`)
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-replication-export-'))

    try {
      await fs.writeFile(
        path.join(stagingDir, 'manifest.json'),
        JSON.stringify(
          {
            formatVersion: REPLICATION_EXPORT_FORMAT_VERSION,
            wikiVersion: WIKI.version,
            exportedAt: Temporal.Now.instant().toString({ smallestUnit: 'millisecond' }),
            siteCount: siteRows.length
          },
          null,
          2
        )
      )
      await fs.writeFile(path.join(stagingDir, 'sites.json'), JSON.stringify(siteRows, null, 2))
      await fs.writeFile(
        path.join(stagingDir, 'classificationLevels.json'),
        JSON.stringify(classificationLevelRows, null, 2)
      )
      await fs.writeFile(
        path.join(stagingDir, 'settings.json'),
        JSON.stringify(settingsRows, null, 2)
      )
      await fs.writeFile(path.join(stagingDir, 'groups.json'), JSON.stringify(groupRows, null, 2))
      await fs.writeFile(path.join(stagingDir, 'users.json'), JSON.stringify(userRows, null, 2))
      await fs.writeFile(
        path.join(stagingDir, 'userGroups.json'),
        JSON.stringify(userGroupRows, null, 2)
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
      await fs.writeFile(
        path.join(stagingDir, 'comments.json'),
        JSON.stringify(commentRows, null, 2)
      )

      // -> Metadata and bytes travel separately: a JSON manifest of every asset's columns other than
      //    `data`/`preview`, plus one archive entry per asset per bytea column actually populated —
      //    same shape `exportSite` uses, just across every site instead of one.
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
   * Delete one snapshot file. Best-effort and idempotent — called once a download has finished
   * streaming, and safe to call again on a file `purgeExpired` already swept.
   */
  async deleteExport(filePath: string): Promise<void> {
    await fs.unlink(filePath).catch(() => {})
  }

  /**
   * Sweep `<dataPath>/exports/` of anything older than the TTL — the snapshot nobody came back to
   * download. Safe to call when the directory does not exist yet (nothing has ever been exported).
   * Shares the directory (and therefore this sweep) with `models/export.ts#purgeExpired` — both
   * TTLs happen to be the same 24 hours today, but each is its own constant so one can change
   * without silently moving the other.
   *
   * @returns How many files were removed
   */
  async purgeExpired(): Promise<number> {
    return purgeFilesOlderThan(this.exportsPath, REPLICATION_EXPORT_TTL_SECONDS)
  }
}

export const replicationExport = new ReplicationExportModel()
