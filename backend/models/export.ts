import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { TarArchive } from 'archiver'
import { v4 as uuid } from 'uuid'
import { eq } from 'drizzle-orm'
import {
  assets as assetsTable,
  groups as groupsTable,
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
 */
export const EXPORT_FORMAT_VERSION = 1

export interface ExportResult {
  filePath: string
  fileSize: number
}

/**
 * Drop columns that are either regenerated from the rest of a row (`ts`, `isSearchableComputed`) or
 * only ever meaningful to the instance that computed them (`searchContent`), rather than to what an
 * import would need to recreate the row.
 */
function stripDerived<T extends Record<string, any>>(row: T): Partial<T> {
  const {
    ts: _ts,
    isSearchableComputed: _isSearchableComputed,
    searchContent: _searchContent,
    ...rest
  } = row as any
  return rest
}

/**
 * Content export model
 *
 * Serializes one site's pages, tree, assets (bytea included) and the (site-wide) groups into a single
 * gzipped tar archive under `<dataPath>/exports/`, for the "Export content" system utility.
 *
 * The tarball is written straight to disk as it is built — `archiver` streams each entry into the
 * gzip/tar pipeline as it is appended, so nothing here holds the finished archive in memory, only the
 * query results that went into it. Queued as a background job (`tasks/simple/export-content.ts`)
 * rather than run inline, since a large site's worth of asset bytes is not something a request thread
 * should be blocked on.
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

    const [pageRows, treeRows, assetRows, groupRows] = await Promise.all([
      WIKI.db.select().from(pagesTable).where(eq(pagesTable.siteId, siteId)),
      WIKI.db.select().from(treeTable).where(eq(treeTable.siteId, siteId)),
      WIKI.db.select().from(assetsTable).where(eq(assetsTable.siteId, siteId)),
      // -> Groups are global, not site-scoped (see CLAUDE.md's Permissions section) — a site's
      //    access model cannot be reconstructed from its own rows alone
      WIKI.db.select().from(groupsTable)
    ])

    await fsp.mkdir(this.exportsPath, { recursive: true })
    const filePath = path.join(this.exportsPath, `${uuid()}.tar.gz`)

    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(filePath)
      const archive = new TarArchive({ gzip: true })

      output.on('close', () => resolve())
      output.on('error', (err: Error) => reject(err))
      archive.on('error', (err: Error) => reject(err))
      archive.pipe(output)

      archive.append(
        JSON.stringify(
          {
            formatVersion: EXPORT_FORMAT_VERSION,
            wikiVersion: WIKI.version,
            exportedAt: Temporal.Now.instant().toString({ smallestUnit: 'millisecond' }),
            siteId
          },
          null,
          2
        ),
        { name: 'manifest.json' }
      )
      archive.append(JSON.stringify(stripDerived(site), null, 2), { name: 'site.json' })
      archive.append(JSON.stringify(pageRows.map(stripDerived), null, 2), { name: 'pages.json' })
      archive.append(JSON.stringify(treeRows.map(stripDerived), null, 2), { name: 'tree.json' })
      archive.append(JSON.stringify(groupRows, null, 2), { name: 'groups.json' })

      // -> Metadata and bytes travel separately: a JSON manifest of every asset's columns other than
      //    `data`/`preview`, plus one archive entry per asset per bytea column actually populated —
      //    appending a Buffer straight into a base64 JSON string would inflate it by a third for no
      //    reason the tar format doesn't already avoid.
      const assetManifest: Record<string, any>[] = []
      for (const asset of assetRows) {
        const { data, preview, ...meta } = asset
        assetManifest.push(meta)
        if (data) {
          archive.append(data, { name: `assets/${asset.id}.data` })
        }
        if (preview) {
          archive.append(preview, { name: `assets/${asset.id}.preview` })
        }
      }
      archive.append(JSON.stringify(assetManifest, null, 2), { name: 'assets/manifest.json' })

      archive.finalize()
    })

    const { size } = await fsp.stat(filePath)
    return { filePath, fileSize: size }
  }

  /**
   * Delete one export file. Best-effort and idempotent — called once a download has finished
   * streaming, and safe to call again on a file `purgeExpired` already swept.
   */
  async deleteExport(filePath: string): Promise<void> {
    await fsp.unlink(filePath).catch(() => {})
  }

  /**
   * Sweep `<dataPath>/exports/` of anything older than the TTL — the export nobody came back to
   * download. Safe to call when the directory does not exist yet (nothing has ever been exported).
   *
   * @returns How many files were removed
   */
  async purgeExpired(): Promise<number> {
    let entries: string[]
    try {
      entries = await fsp.readdir(this.exportsPath)
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return 0
      }
      throw err
    }

    const cutoff = Temporal.Now.instant().subtract({ seconds: EXPORT_TTL_SECONDS })
    let purged = 0
    for (const entry of entries) {
      const entryPath = path.join(this.exportsPath, entry)
      const stat = await fsp.stat(entryPath)
      if (Temporal.Instant.compare(stat.mtime.toTemporalInstant(), cutoff) < 0) {
        await fsp.unlink(entryPath)
        purged++
      }
    }
    return purged
  }
}

export const exportModel = new ExportModel()
