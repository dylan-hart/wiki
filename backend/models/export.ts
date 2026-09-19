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

const EXPORT_TTL_SECONDS = 24 * 60 * 60

/**
 * The archive format `exportSite` writes and `importSite` reads back — the shape of `manifest.json`
 * plus what each of the other entries means, not the running `wikiVersion`. Bumped only when that
 * shape changes; an import whose manifest names a different version is refused outright rather than
 * restored best-effort.
 */
export const EXPORT_FORMAT_VERSION = 2

export interface ExportResult {
  filePath: string
  fileSize: number
}

/**
 * `ts` is regenerated from the rest of a row and `searchContent` is only ever meaningful to the
 * instance that computed it, so neither is anything an import needs to recreate the row.
 */
function stripDerived<T extends Record<string, any>>(row: T): Partial<T> {
  const { ts: _ts, searchContent: _searchContent, ...rest } = row as any
  return rest
}

/**
 * Serializes one site's pages, tree, page history, navigation, assets (bytea included) and the
 * instance-wide groups into a single gzipped tar archive under `<dataPath>/exports/`.
 *
 * Every entry is staged into a temp directory first: `node-tar` only ever reads entries from real
 * files on disk (it lstats each path itself), so there is no way to hand it a JSON string or an
 * asset `Buffer` directly. That directory sits outside `<dataPath>/exports/` so a leftover from a
 * crashed run is never mistaken by `purgeExpired()` for one of its own `.tar.gz` files.
 *
 * Queued as a background job rather than run inline, since a large site's worth of asset bytes is
 * not something a request thread should be blocked on.
 */
class ExportModel {
  get exportsPath(): string {
    return path.resolve(CARDINAL.ROOTPATH, CARDINAL.config.dataPath, 'exports')
  }

  async exportSite(siteId: string): Promise<ExportResult> {
    const siteRows = await CARDINAL.db
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
        CARDINAL.db.select().from(pagesTable).where(eq(pagesTable.siteId, siteId)),
        CARDINAL.db.select().from(treeTable).where(eq(treeTable.siteId, siteId)),
        CARDINAL.db.select().from(assetsTable).where(eq(assetsTable.siteId, siteId)),
        CARDINAL.db.select().from(pageHistoryTable).where(eq(pageHistoryTable.siteId, siteId)),
        CARDINAL.db.select().from(navigationTable).where(eq(navigationTable.siteId, siteId)),
        // -> Groups are global, not site-scoped: a site's access model cannot be reconstructed from
        //    its own rows alone. `isSystem` rows are excluded because `importSite` upserts by id and
        //    the target instance seeds its own -- Users/Guests sit at fixed cross-instance ids, so
        //    restoring them would overwrite that instance's wholesale, while Administrators is
        //    per-instance random and would land as a non-privileged duplicate.
        CARDINAL.db.select().from(groupsTable).where(eq(groupsTable.isSystem, false))
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
            wikiVersion: CARDINAL.version,
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

      // -> Metadata and bytes travel separately: base64ing a Buffer into the JSON manifest would
      //    inflate it by a third for no reason the tar format doesn't already avoid.
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

  /** Best-effort and idempotent: `purgeExpired` may already have swept the file. */
  async deleteExport(filePath: string): Promise<void> {
    await fs.unlink(filePath).catch(() => {})
  }

  async purgeExpired(): Promise<number> {
    return purgeFilesOlderThan(this.exportsPath, EXPORT_TTL_SECONDS)
  }
}

export const exportModel = new ExportModel()
