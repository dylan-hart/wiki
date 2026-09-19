import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import crypto from 'node:crypto'
import { chunk } from 'es-toolkit/array'
import {
  ASSET_INSERT_CHUNK_SIZE,
  NAVIGATION_INSERT_CHUNK_SIZE,
  PAGE_HISTORY_INSERT_CHUNK_SIZE,
  PAGE_INSERT_CHUNK_SIZE,
  readArchive,
  readJson,
  TREE_INSERT_CHUNK_SIZE
} from './siteImport.ts'
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
import { CustomError } from '../helpers/common.ts'
import { purgeFilesOlderThan } from '../helpers/fsPurge.ts'

const IMPORT_TTL_SECONDS = 24 * 60 * 60

/**
 * Bumped when the manifest/tarball shape changes; an archive naming any other version is refused
 * outright rather than restored best-effort. Deliberately independent of
 * `models/export.ts#EXPORT_FORMAT_VERSION`, which describes one site's content archive.
 */
export const REPLICATION_FORMAT_VERSION = 1

/** Chunk sizes for the tables `siteImport.ts` does not already export one for, derived the same way:
 *  `floor(MAX_BIND_PARAMETERS / boundColumnCount)` over each table's `db/schema.ts` columns. */
const MAX_BIND_PARAMETERS = 65535
const SITE_INSERT_CHUNK_SIZE = Math.floor(MAX_BIND_PARAMETERS / 5)
const CLASSIFICATION_INSERT_CHUNK_SIZE = Math.floor(MAX_BIND_PARAMETERS / 5)
const GROUP_INSERT_CHUNK_SIZE = Math.floor(MAX_BIND_PARAMETERS / 10)
const USER_INSERT_CHUNK_SIZE = Math.floor(MAX_BIND_PARAMETERS / 14)
const USER_GROUP_INSERT_CHUNK_SIZE = Math.floor(MAX_BIND_PARAMETERS / 2)
const COMMENT_INSERT_CHUNK_SIZE = Math.floor(MAX_BIND_PARAMETERS / 12)
const SETTING_INSERT_CHUNK_SIZE = Math.floor(MAX_BIND_PARAMETERS / 2)

export interface ReplicationImportReport {
  sites: number
  classificationLevels: number
  groups: number
  users: number
  userGroups: number
  navigation: number
  tree: number
  pages: number
  pageHistory: number
  assets: number
  comments: number
  settings: number
}

type ArchiveRow = Record<string, any>

/** Guards against a producer that includes either column anyway: `ts` is a `tsvector` postgres
 *  computes from other columns, not a value this can hand back to it, and `searchContent` is derived
 *  at index time. */
export function stripDerivedPageColumns(row: ArchiveRow): ArchiveRow {
  const { ts: _ts, searchContent: _searchContent, ...rest } = row
  return rest
}

/**
 * `comments.replyTo` self-references another row in the same table, so a chunked insert cannot
 * guarantee a reply lands after its parent the way a plain foreign key elsewhere in this archive
 * can. Multi-pass rather than a single sort, since the depth is unbounded.
 */
export function orderCommentsByReplyDepth(rows: ArchiveRow[]): ArchiveRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const placed = new Set<string>()
  const ordered: ArchiveRow[] = []
  let remaining = rows.filter((row) => row.replyTo == null || byId.has(row.replyTo))
  let unresolvable = rows.filter((row) => row.replyTo != null && !byId.has(row.replyTo))

  while (remaining.length > 0) {
    const [ready, notReady] = [
      remaining.filter((row) => row.replyTo == null || placed.has(row.replyTo)),
      remaining.filter((row) => row.replyTo != null && !placed.has(row.replyTo))
    ]
    if (ready.length === 0) {
      // -> Nothing placeable: every remaining row points at another remaining row, so it is a cycle
      //    rather than a chain, and refusing it beats looping forever.
      unresolvable = [...unresolvable, ...notReady]
      break
    }
    for (const row of ready) {
      ordered.push(row)
      placed.add(row.id)
    }
    remaining = notReady
  }

  if (unresolvable.length > 0) {
    throw new Error(
      `Malformed replication archive: ${unresolvable.length} comment(s) have a replyTo that never resolves (dangling reference or a cycle) — first offending id: ${unresolvable[0].id}.`
    )
  }

  return ordered
}

/**
 * Target side of replication: restores a whole-instance snapshot tarball, wiping every table the
 * snapshot covers — settings included — before inserting the archive's own rows.
 *
 * **No id remapping**, unlike `siteImport.ts`: a whole-instance wipe-and-replace has no coexistence
 * case, so the archive's own ids are used exactly as given.
 *
 * **Cache/index invalidation is deliberately not this model's job**, matching `siteImport.ts`'s own
 * convention: every caller of `importSnapshot()` runs `helpers/replicationPostImport.ts` once it has
 * returned successfully.
 */
class ReplicationImportModel {
  /** Separate from `siteImport.ts`'s own `<dataPath>/imports`, so the two importers' TTL sweeps
   *  never race the same directory. */
  get importsPath(): string {
    return path.resolve(CARDINAL.ROOTPATH, CARDINAL.config.dataPath, 'imports', 'replication')
  }

  /**
   * Streamed straight from the request: `bodyLimit` is enforced mid-stream so an oversized body is
   * refused before it is all on disk, and the gzip magic number is only checkable once the write
   * has completed.
   */
  async saveUpload(stream: NodeJS.ReadableStream, bodyLimit: number): Promise<string> {
    await fs.mkdir(this.importsPath, { recursive: true })
    const filePath = path.join(this.importsPath, `${crypto.randomUUID()}.tar.gz`)
    let received = 0

    const limitEnforcer = new Transform({
      transform(chunkData, _encoding, callback) {
        received += chunkData.length
        if (received > bodyLimit) {
          callback(
            new CustomError(
              'replicationImportUploadTooLarge',
              `The archive is larger than the ${Math.round(bodyLimit / 1024 / 1024)} MB import limit.`,
              413
            )
          )
          return
        }
        callback(null, chunkData)
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
      throw new CustomError('replicationImportEmptyFile', 'No archive was sent.', 400)
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
        'replicationImportNotGzip',
        'Not a gzip archive, whatever the request said it was.',
        400
      )
    }

    return filePath
  }

  async deleteUpload(filePath: string): Promise<void> {
    await fs.unlink(filePath).catch(() => {})
  }

  /** Catches uploads whose job never ran to completion to clean up after itself. */
  async purgeExpired(): Promise<number> {
    return purgeFilesOlderThan(this.importsPath, IMPORT_TTL_SECONDS)
  }

  /** Wipe and replace in one transaction, so a failure part-way leaves the instance as it was. */
  async importSnapshot(filePath: string): Promise<ReplicationImportReport> {
    const { entries, assetBlobs, stagingDir } = await readArchive(filePath)

    try {
      const manifest = readJson<{ formatVersion?: number; generatedAt?: string }>(
        entries,
        'manifest.json'
      )
      if (manifest.formatVersion !== REPLICATION_FORMAT_VERSION) {
        throw new Error(
          `Unsupported replication archive version ${manifest.formatVersion ?? '(none)'} — this instance can only restore version ${REPLICATION_FORMAT_VERSION} archives.`
        )
      }

      const siteRows = readJson<ArchiveRow[]>(entries, 'sites.json')
      const classificationRows = readJson<ArchiveRow[]>(entries, 'classificationLevels.json')
      const groupRows = readJson<ArchiveRow[]>(entries, 'groups.json')
      const userRows = readJson<ArchiveRow[]>(entries, 'users.json')
      const userGroupRows = readJson<ArchiveRow[]>(entries, 'userGroups.json')
      const navigationRows = readJson<ArchiveRow[]>(entries, 'navigation.json')
      const treeRows = readJson<ArchiveRow[]>(entries, 'tree.json')
      const pageRows = readJson<ArchiveRow[]>(entries, 'pages.json').map(stripDerivedPageColumns)
      const pageHistoryRows = readJson<ArchiveRow[]>(entries, 'pageHistory.json')
      const commentRows = orderCommentsByReplyDepth(
        readJson<ArchiveRow[]>(entries, 'comments.json')
      )
      const assetManifest = readJson<ArchiveRow[]>(entries, 'assets/manifest.json')
      const settingRows = readJson<ArchiveRow[]>(entries, 'settings.json')

      // -> `readArchive` stages asset blobs to disk rather than buffering them, so `assetBlobs`
      //    holds paths, not bytes.
      const assetRows = await Promise.all(
        assetManifest.map(async (meta) => {
          const dataPath = assetBlobs[`assets/${meta.id}.data`]
          const previewPath = assetBlobs[`assets/${meta.id}.preview`]
          return {
            ...meta,
            data: dataPath ? await fs.readFile(dataPath) : null,
            preview: previewPath ? await fs.readFile(previewPath) : null
          }
        })
      )

      await CARDINAL.db.transaction(async (tx) => {
        // -> Children first, mirroring each table's foreign keys: the order only has to satisfy
        //    Postgres's own constraint checks, since a failure rolls the whole transaction back.
        await tx.delete(commentsTable)
        await tx.delete(pageHistoryTable)
        await tx.delete(treeTable)
        await tx.delete(pagesTable)
        await tx.delete(assetsTable)
        await tx.delete(navigationTable)
        await tx.delete(userGroupsTable)
        await tx.delete(usersTable)
        await tx.delete(groupsTable)
        await tx.delete(classificationLevelsTable)
        await tx.delete(settingsTable)
        await tx.delete(sitesTable)

        for (const batch of chunk(siteRows, SITE_INSERT_CHUNK_SIZE)) {
          await tx.insert(sitesTable).values(batch as any)
        }
        for (const batch of chunk(classificationRows, CLASSIFICATION_INSERT_CHUNK_SIZE)) {
          await tx.insert(classificationLevelsTable).values(batch as any)
        }
        for (const batch of chunk(groupRows, GROUP_INSERT_CHUNK_SIZE)) {
          await tx.insert(groupsTable).values(batch as any)
        }
        for (const batch of chunk(userRows, USER_INSERT_CHUNK_SIZE)) {
          await tx.insert(usersTable).values(batch as any)
        }
        for (const batch of chunk(userGroupRows, USER_GROUP_INSERT_CHUNK_SIZE)) {
          await tx.insert(userGroupsTable).values(batch as any)
        }
        // -> Navigation before tree: a tree row's `navigationId` is a foreign key into
        //    `navigation.id`.
        for (const batch of chunk(navigationRows, NAVIGATION_INSERT_CHUNK_SIZE)) {
          await tx.insert(navigationTable).values(batch as any)
        }
        for (const batch of chunk(pageRows, PAGE_INSERT_CHUNK_SIZE)) {
          await tx.insert(pagesTable).values(batch as any)
        }
        for (const batch of chunk(treeRows, TREE_INSERT_CHUNK_SIZE)) {
          await tx.insert(treeTable).values(batch as any)
        }
        for (const batch of chunk(assetRows, ASSET_INSERT_CHUNK_SIZE)) {
          await tx.insert(assetsTable).values(batch as any)
        }
        for (const batch of chunk(pageHistoryRows, PAGE_HISTORY_INSERT_CHUNK_SIZE)) {
          await tx.insert(pageHistoryTable).values(batch as any)
        }
        // -> Safe across chunk boundaries only because `orderCommentsByReplyDepth` puts every parent
        //    in an earlier or the same chunk as its reply.
        for (const batch of chunk(commentRows, COMMENT_INSERT_CHUNK_SIZE)) {
          await tx.insert(commentsTable).values(batch as any)
        }
        for (const batch of chunk(settingRows, SETTING_INSERT_CHUNK_SIZE)) {
          await tx.insert(settingsTable).values(batch as any)
        }
      })

      return {
        sites: siteRows.length,
        classificationLevels: classificationRows.length,
        groups: groupRows.length,
        users: userRows.length,
        userGroups: userGroupRows.length,
        navigation: navigationRows.length,
        tree: treeRows.length,
        pages: pageRows.length,
        pageHistory: pageHistoryRows.length,
        assets: assetRows.length,
        comments: commentRows.length,
        settings: settingRows.length
      }
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

export const replicationImportModel = new ReplicationImportModel()
