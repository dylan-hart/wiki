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

/** How long an uploaded replication archive sits on disk before `purgeExpired` sweeps it, in seconds. */
const IMPORT_TTL_SECONDS = 24 * 60 * 60

/**
 * The manifest/tarball shape this model reads back — see
 * `docs/decisions/bulk-replication-wire-format.md` for the full contract (entry list, table
 * ordering, the settings-wipe caveat). Bumped only when that shape changes; an archive naming a
 * different version is refused outright rather than restored best-effort, same precedent as
 * `models/export.ts#EXPORT_FORMAT_VERSION`/`models/siteImport.ts`. Deliberately independent of
 * `EXPORT_FORMAT_VERSION` — that constant describes one site's content archive, an unrelated payload.
 */
export const REPLICATION_FORMAT_VERSION = 1

/** Column counts for the tables this model restores that `siteImport.ts` does not already cover a
 *  chunk size for. Same derivation as that file's own constants: `floor(MAX_BIND_PARAMETERS /
 *  boundColumnCount)`. See `db/schema.ts` for each table's real column list. */
const MAX_BIND_PARAMETERS = 65535
/** `sites`: id, hostname, isEnabled, config, createdAt. */
const SITE_INSERT_CHUNK_SIZE = Math.floor(MAX_BIND_PARAMETERS / 5)
/** `classificationLevels`: id, name, sortOrder, createdAt, updatedAt. */
const CLASSIFICATION_INSERT_CHUNK_SIZE = Math.floor(MAX_BIND_PARAMETERS / 5)
/** `groups`: id, name, permissions, rules, redirectOnLogin, redirectOnFirstLogin, redirectOnLogout,
 *  isSystem, createdAt, updatedAt. */
const GROUP_INSERT_CHUNK_SIZE = Math.floor(MAX_BIND_PARAMETERS / 10)
/** `users`: id, email, name, auth, meta, passkeys, prefs, hasAvatar, isActive, isSystem, isVerified,
 *  lastLoginAt, createdAt, updatedAt. */
const USER_INSERT_CHUNK_SIZE = Math.floor(MAX_BIND_PARAMETERS / 14)
/** `userGroups`: userId, groupId. */
const USER_GROUP_INSERT_CHUNK_SIZE = Math.floor(MAX_BIND_PARAMETERS / 2)
/** `comments`: id, content, render, guestName, guestEmail, guestIp, createdAt, updatedAt, pageId,
 *  siteId, authorId, replyTo. */
const COMMENT_INSERT_CHUNK_SIZE = Math.floor(MAX_BIND_PARAMETERS / 12)
/** `settings`: key, value. */
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

/** One row as read out of a JSON archive entry — no static shape beyond having an `id`. */
type ArchiveRow = Record<string, any>

/** Drop the two columns `models/export.ts#stripDerived` already excludes from a page export, in case
 *  a producer ever includes them anyway — `ts` is a `tsvector` postgres computes from other columns,
 *  not a value this can hand back to it, and `searchContent` is derived at index time.
 *
 *  Exported for its own pure unit test. */
export function stripDerivedPageColumns(row: ArchiveRow): ArchiveRow {
  const { ts: _ts, searchContent: _searchContent, ...rest } = row
  return rest
}

/**
 * Order comment rows so every reply comes after the row it replies to, since `comments.replyTo`
 * self-references another row in the same table and a single chunked insert cannot guarantee that
 * ordering across an arbitrary chunk boundary the way a plain foreign key elsewhere in this archive
 * can.
 *
 * Multi-pass rather than a single sort: each pass takes every row whose `replyTo` is either null or
 * already placed, until nothing is left. A row whose `replyTo` never resolves — a dangling reference,
 * or a genuine cycle, neither of which real exported data should ever contain — is reported rather
 * than silently dropped or looped on forever.
 *
 * Exported for its own pure unit test.
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
      // -> Nothing in this pass could be placed: every remaining row's `replyTo` points at another
      //    remaining row, so it's a cycle rather than a chain — should never occur in real exported
      //    data, but refused outright rather than silently dropped.
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
 * Target-side bulk-import model
 *
 * Restores a whole-instance snapshot tarball into this instance, wiping every table the snapshot
 * covers before inserting the archive's own rows — the "wipe-and-replace" half of Feature #2437's
 * scheduled replication (the other half, producing the archive, is sibling WP #2489/`models/
 * export.ts` territory, source side, not yet built). See
 * `docs/decisions/bulk-replication-wire-format.md` for the full manifest shape, table ordering and
 * the accepted settings-wipe consequence — this class implements exactly what that document decides.
 *
 * Reuses `models/siteImport.ts#readArchive`/`#readJson` for the tar-reading mechanics (asset blobs
 * staged to disk, decompressed-size ceilings, JSON entries fully buffered) rather than re-deriving
 * them — the archive shape for assets specifically is unchanged from that file's own (`assets/
 * manifest.json` + `assets/<id>.data`/`.preview` entries).
 *
 * **No id remapping**, unlike `siteImport.ts`: a whole-instance wipe-and-replace has no coexistence
 * case (every row of every covered table is gone before anything is inserted), so the archive's own
 * ids are used exactly as given — see the design doc's Context section for why that differs from the
 * single-site restore this otherwise mirrors.
 *
 * **Cache/index invalidation is deliberately not this method's job**, matching `siteImport.ts`'s own
 * convention — `tasks/simple/replication-import.ts`, the sole caller, reloads the `ClusterReloaded`
 * caches (`sites`, `groups`, `classificationLevels`) and queues search reindexing once this has
 * actually returned successfully.
 */
class ReplicationImportModel {
  /** `<dataPath>/imports/replication` — separate from `siteImport.ts`'s own `<dataPath>/imports`, so
   *  the two importers' TTL sweeps never race the same directory. */
  get importsPath(): string {
    return path.resolve(WIKI.ROOTPATH, WIKI.config.dataPath, 'imports', 'replication')
  }

  /**
   * Save an uploaded archive to `<dataPath>/imports/replication/`, streaming it straight from the
   * request — same approach and same reasoning as `models/siteImport.ts#saveUpload`, which this
   * mirrors line-for-line (see that method's own doc comment for the full rationale on why
   * `bodyLimit` is enforced mid-stream and the gzip check runs after the write completes).
   *
   * @returns The path the queued job reads it back from.
   * @throws {CustomError} the body exceeded `bodyLimit` (413), nothing was sent (400), or the saved
   *   file's first two bytes are not the gzip magic number (400).
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

  /** Delete one uploaded archive. Best-effort and idempotent. */
  async deleteUpload(filePath: string): Promise<void> {
    await fs.unlink(filePath).catch(() => {})
  }

  /** Sweep `<dataPath>/imports/replication/` of anything older than the TTL — an upload whose job
   *  never ran to completion to clean up after itself. Safe to call when the directory does not
   *  exist yet.
   *
   * @returns How many files were removed */
  async purgeExpired(): Promise<number> {
    return purgeFilesOlderThan(this.importsPath, IMPORT_TTL_SECONDS)
  }

  /**
   * Wipe this instance's replicated tables and replace them with a snapshot archive's own rows, in
   * one transaction.
   *
   * @param filePath Path to the uploaded archive, as returned by `saveUpload`.
   * @returns How many rows of each kind were restored, which the caller (`replicationImport`'s task)
   *   records on the job's history row via `WIKI.models.jobs.setResult`.
   */
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

      // -> Staged to disk by `readArchive` rather than held in memory — read back here, one asset at
      //    a time, only now that a row is actually about to be built for it. Mirrors
      //    `siteImport.ts#importSite`'s own `mappedAssetRows`.
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

      await WIKI.db.transaction(async (tx) => {
        // -> Children first, mirroring each table's real foreign keys (see the design doc's ordering
        //    table) — a mid-transaction failure rolls back the whole thing, so this order only has to
        //    satisfy Postgres's own constraint checks, not guard against a partial state surviving.
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
        // -> Navigation before tree: a tree row's `navigationId` (a per-entry override) is a foreign
        //    key into `navigation.id`.
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
        // -> One chunk of a topologically-ordered list at a time: a chunk boundary can still separate
        //    a reply from its parent, but the parent was always inserted in an earlier or the same
        //    chunk by construction (`orderCommentsByReplyDepth`), and each `.insert()` call commits
        //    within the same transaction before the next chunk's rows are bound, so the FK is always
        //    satisfied by the time a later chunk's reply rows are inserted.
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
