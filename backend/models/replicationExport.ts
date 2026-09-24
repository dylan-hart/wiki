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

const REPLICATION_EXPORT_TTL_SECONDS = 24 * 60 * 60

/**
 * The archive's shape, not the running `wikiVersion`, and bumped only when that shape changes: a
 * target instance whose importer does not recognize a manifest's `formatVersion` refuses it
 * outright rather than restoring best-effort.
 */
export const REPLICATION_EXPORT_FORMAT_VERSION = 1

export interface ReplicationExportResult {
  filePath: string
  fileSize: number
}

/**
 * `ts` is regenerated from the rest of the row and `searchContent` means nothing to another
 * instance, so neither is part of what an import needs. Deliberately a separate copy of
 * `models/export.ts`'s `stripDerived`: the two archive formats are independent contracts that strip
 * the same columns today, not one that must always agree with the other.
 */
function stripDerived<T extends Record<string, any>>(row: T): Partial<T> {
  const { ts: _ts, searchContent: _searchContent, ...rest } = row as any
  return rest
}

/**
 * Serializes the ENTIRE instance — every site, assets included — into one gzipped tar archive,
 * except users' personal notes (`notes`, `noteSections`, `noteImages`): they are readable by their
 * owner alone, and an archive is readable by whoever holds it
 * (`docs/decisions/2026-09-23-personal-notes-data-model.md`).
 * Deliberately a different surface from `models/export.ts#exportSite`, which serializes one site's
 * content under its own format version and importer contract.
 *
 * Two deliberate divergences from `exportSite`, both because this is a whole-instance
 * wipe-and-replace rather than a restore layered onto an otherwise-live target:
 *
 * - `groups.json` INCLUDES `isSystem` rows. `exportSite` excludes them because its target site has
 *   its own seeded system groups to collide with; here the target's database is wiped first, so
 *   omitting them would leave the mirror without a working Administrators group at all.
 * - `settings.json` is included at all, sensitive values (mail/storage credentials, the auth
 *   secret) and all. Acceptable because the route this model backs is `manage:system`-only, exactly
 *   as sensitive as `GET /_api/system/settings` already is.
 *
 * Entries are staged in a temp directory first because `node-tar`'s `create()` only ever reads
 * entries from real files — a JSON string or an asset `Buffer` cannot be handed to it. Staging sits
 * outside `<dataPath>/exports/` so a leftover from a crashed run is never mistaken by
 * `purgeExpired()` for a finished export.
 *
 * Every table in scope is read into memory in one `select()`: no streaming or pagination, the same
 * ceiling `exportSite` already accepts for a single site.
 */
class ReplicationExportModel {
  get exportsPath(): string {
    return path.resolve(CARDINAL.ROOTPATH, CARDINAL.config.dataPath, 'exports')
  }

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
      CARDINAL.db.select().from(sitesTable),
      CARDINAL.db.select().from(classificationLevelsTable),
      CARDINAL.db.select().from(settingsTable),
      CARDINAL.db.select().from(groupsTable),
      CARDINAL.db.select().from(usersTable),
      CARDINAL.db.select().from(userGroupsTable),
      CARDINAL.db.select().from(pagesTable),
      CARDINAL.db.select().from(treeTable),
      CARDINAL.db.select().from(pageHistoryTable),
      CARDINAL.db.select().from(navigationTable),
      CARDINAL.db.select().from(commentsTable)
    ])
    const assetRows = await CARDINAL.db.select().from(assetsTable)

    await fs.mkdir(this.exportsPath, { recursive: true })
    const filePath = path.join(this.exportsPath, `${crypto.randomUUID()}.tar.gz`)
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-replication-export-'))

    try {
      await fs.writeFile(
        path.join(stagingDir, 'manifest.json'),
        JSON.stringify(
          {
            formatVersion: REPLICATION_EXPORT_FORMAT_VERSION,
            wikiVersion: CARDINAL.version,
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

      // -> Metadata and bytes travel separately: a JSON manifest of every column but
      //    `data`/`preview`, plus one archive entry per bytea column actually populated
      const assetsDir = path.join(stagingDir, 'assets')
      await fs.mkdir(assetsDir, { recursive: true })
      const assetManifest: Record<string, any>[] = []
      for (const asset of assetRows) {
        const { data, preview, ts: _ts, searchContent: _searchContent, ...meta } = asset
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

  /** Best-effort: the file may already have been swept by `purgeExpired` or a previous call. */
  async deleteExport(filePath: string): Promise<void> {
    await fs.unlink(filePath).catch(() => {})
  }

  /**
   * Sweeps the directory `models/export.ts#purgeExpired` also sweeps, and therefore its files too.
   * The two TTLs are equal today but stay separate constants so one can change without moving the
   * other.
   */
  async purgeExpired(): Promise<number> {
    return purgeFilesOlderThan(this.exportsPath, REPLICATION_EXPORT_TTL_SECONDS)
  }
}

export const replicationExport = new ReplicationExportModel()
