import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * A small, versioned, self-contained staging format for 2.x `comments` rows — Task 752's own design,
 * since neither the `SourceConnector` interface (`backend/migration/connector.ts`) nor the mapping
 * doc (`docs/migration/2.5x-to-3.0-mapping.md`'s `comments` section) commit to one: 3.0 has no
 * `comments` table yet (Epic 335 owns designing it from scratch), so this module cannot write into a
 * destination table the way `importer/assets.ts` writes straight into `assets`/`tree`. Instead it
 * writes one NDJSON file per site — one JSON object per line, one line per comment — plus a small
 * JSON manifest recording the format's schema version and the row count, inside a "migration bundle
 * directory" the caller owns the lifecycle of (an importer run's working/output directory, not the
 * 2.x *source* Export-to-Disk bundle `2.5x-export-bundle-format.md` documents — an unrelated,
 * unrelated-in-direction concept that happens to share the word "bundle").
 *
 * ---
 * **No `comments` table write happens in this module, on purpose.** `readCommentsStagingBundle`
 * below is the load side epic 335's *future* comments-table writer is expected to consume once that
 * schema exists — this module stops at handing back parsed `StagedComment` rows and never touches
 * `WIKI.db`. Do not add a comments-table insert here; that boundary is epic 335's to own.
 * ---
 */

/**
 * Bumped whenever `StagedComment`'s field set changes (added/removed/renamed) in a way an older
 * reader would misparse. `readCommentsStagingManifest`/`readCommentsStagingBundle` refuse to read a
 * bundle whose manifest names any other version, rather than silently guessing at a shape.
 */
export const COMMENTS_STAGING_SCHEMA_VERSION = 1

/**
 * One 2.x `comments` row, as read off a 2.x source — see `docs/migration/2.5x-source-schema.md`'s
 * `comments` section for the full 2.x column set. Only the columns this task's own description names
 * are carried here; `replyTo` (added `2.4.61.js`) is explicitly out of this task's scope — it is not
 * staged, and threading is left for whichever future task wires `replyTo` once Epic 335 decides how a
 * self-reply reference should be represented in the 3.0 schema.
 */
export interface SourceCommentRecord {
  id: number
  content: string
  render: string
  name: string
  email: string
  ip: string
  /** Nullable in 2.x — a comment posted by a guest carries no author. */
  authorId: number | null
  /** Nullable in 2.x's own schema (no `.notNullable()` on the column), though in practice every
   *  comment is posted against some page. Treated identically to an id the page-id map has no entry
   *  for: see `stageComment`. */
  pageId: number | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Structural contract this module consumes from #414 (Users, Groups & Permissions): an old 2.x
 * `users.id` resolved to whatever UUID the user importer created for it. #414 owns building the real
 * instance; `backend/migration/id-map.ts`'s `IdMap<number>` (once that feature lands on this branch)
 * satisfies this directly, with no adapter needed — this module depends only on the shape, not on
 * importing that file, since #414's work lives on a different branch as of this task.
 */
export interface UserIdMap {
  get(oldUserId: number): string | undefined
}

/**
 * Structural contract this module consumes from #416 (Content: Pages, History, Navigation & Tags):
 * an old 2.x `pages.id` resolved to whatever UUID the page importer created for it. Same relationship
 * to #416 as `UserIdMap` has to #414 — see that doc comment.
 */
export interface PageIdMap {
  get(oldPageId: number): string | undefined
}

/**
 * One staged comment row — JSON-serializable (it is written and read back as one NDJSON line), and
 * deliberately carrying both the *resolved* 3.0 reference and the *raw source* id next to it
 * (`sourcePageId`, `sourceAuthorId`), so a reference that could not be resolved during this run is
 * still on record rather than silently lost — it can be reattached by hand, or by a future run with a
 * more complete id-map, without re-reading the 2.x source.
 */
export interface StagedComment {
  id: number
  content: string
  render: string
  name: string
  email: string
  ip: string
  /** The 3.0 user UUID, or `null` for a guest comment (source `authorId` was null) *or* a non-null
   *  source `authorId` the user-id map had no entry for — see `stageComment`'s doc comment for why
   *  the latter is not substituted with a system user the way `importer/assets.ts` does. */
  authorId: string | null
  /** The raw 2.x `authorId`, kept regardless of whether it resolved — `null` only when the source
   *  comment genuinely had no author (a guest comment), never as a stand-in for "unresolved". */
  sourceAuthorId: number | null
  /** The 3.0 page UUID this comment resolved onto, or `null` when unresolved — see
   *  `unresolvedPageId`. */
  pageId: string | null
  /** The raw 2.x `pageId`, kept regardless of whether it resolved. */
  sourcePageId: number | null
  /** `true` when `pageId` could not be resolved to an imported page — either the source `pageId` was
   *  itself null, or it named a 2.x page that exists but fell outside this import's scope (excluded
   *  from the page-id map). A comment is still staged in this case, never dropped; a later pass can
   *  decide what to do with an orphaned comment once the page it belonged to is known not to exist in
   *  3.0. */
  unresolvedPageId: boolean
  /** ISO-8601, `Temporal.Instant`-compatible (`{ smallestUnit: 'millisecond' }` precision — matches
   *  what the rest of the codebase writes to/reads from postgres). */
  createdAt: string
  updatedAt: string
}

/** What a bundle's manifest records for one site's comments — schema version (see
 *  `COMMENTS_STAGING_SCHEMA_VERSION`) plus enough of a row count that a reader can detect a
 *  truncated/corrupted data file instead of silently under-reading it. */
export interface CommentsStagingManifest {
  schemaVersion: number
  siteId: string
  rowCount: number
  /** How many of `rowCount` rows had `unresolvedPageId: true` — surfaced on the manifest so an
   *  operator can see the scale of orphaned comments without reading the full NDJSON file. */
  unresolvedPageIdCount: number
  generatedAt: string
}

/** Thrown by `readCommentsStagingManifest`/`readCommentsStagingBundle` when a bundle's manifest names
 *  a schema version this reader does not know how to interpret. */
export class UnsupportedCommentsStagingSchemaVersionError extends Error {
  constructor(found: number) {
    super(
      `Comments staging bundle has schema version ${found}, but this reader only supports version ` +
        `${COMMENTS_STAGING_SCHEMA_VERSION}.`
    )
    this.name = 'UnsupportedCommentsStagingSchemaVersionError'
  }
}

/** Thrown by `readCommentsStagingBundle` when the data file's actual line count disagrees with the
 *  manifest's recorded `rowCount` — a truncated write or a hand-edited file, not a shape this reader
 *  should silently under- or over-read. */
export class CommentsStagingRowCountMismatchError extends Error {
  constructor(expected: number, found: number) {
    super(
      `Comments staging bundle declares row count ${expected} but its data file has ${found} rows.`
    )
    this.name = 'CommentsStagingRowCountMismatchError'
  }
}

function commentsDir(bundleDir: string): string {
  return path.join(bundleDir, 'comments')
}

function commentsDataPath(bundleDir: string, siteId: string): string {
  return path.join(commentsDir(bundleDir), `${siteId}.ndjson`)
}

function commentsManifestPath(bundleDir: string, siteId: string): string {
  return path.join(commentsDir(bundleDir), `${siteId}.manifest.json`)
}

/**
 * Remaps one 2.x comment row onto the staging shape: `pageId` through `pageIdMap`, non-null
 * `authorId` through `userIdMap`, `content`/`render` passed through unchanged.
 *
 * `authorId` handling deliberately does **not** mirror `importer/assets.ts`'s `writeImportedAsset`,
 * which falls back to `systemIds.userAdminId` for an asset whose author could not be resolved: a
 * comment's `name`/`email`/`ip` already carry a guest identity 2.x recorded for exactly this case, so
 * attributing an unresolved comment to an admin/system user would be actively wrong, not merely a
 * safe default. Both the guest case (source `authorId` was null) and the unresolved case (source
 * `authorId` was non-null but absent from `userIdMap`) land on `authorId: null` here.
 *
 * `pageId` resolution failure is recorded via `unresolvedPageId: true` rather than skipped — see
 * `StagedComment`'s doc comment.
 */
export function stageComment(
  record: SourceCommentRecord,
  pageIdMap: PageIdMap,
  userIdMap: UserIdMap
): StagedComment {
  const resolvedPageId = record.pageId === null ? undefined : pageIdMap.get(record.pageId)
  const resolvedAuthorId = record.authorId === null ? undefined : userIdMap.get(record.authorId)

  return {
    id: record.id,
    content: record.content,
    render: record.render,
    name: record.name,
    email: record.email,
    ip: record.ip,
    authorId: resolvedAuthorId ?? null,
    sourceAuthorId: record.authorId,
    pageId: resolvedPageId ?? null,
    sourcePageId: record.pageId,
    unresolvedPageId: resolvedPageId === undefined,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString()
  }
}

/**
 * Stages every comment `comments` yields for one site: writes `<bundleDir>/comments/<siteId>.ndjson`
 * (one `StagedComment` per line) and `<bundleDir>/comments/<siteId>.manifest.json`, then returns the
 * manifest that was written.
 *
 * `comments` is deliberately just `Iterable | AsyncIterable<SourceCommentRecord>` rather than typed
 * against `SourceConnector` (`backend/migration/connector.ts`): that interface has no `comments()`
 * generator yet — `docs/migration/2.5x-to-3.0-mapping.md`'s `comments` section calls this out as a
 * gap for the connector itself to close in a task that owns it, which this one does not — so a caller
 * hands this function whatever it already assembled (a connector-backed generator, once one exists,
 * or an in-memory array in the meantime).
 */
export async function writeCommentsStagingBundle(
  bundleDir: string,
  siteId: string,
  comments: Iterable<SourceCommentRecord> | AsyncIterable<SourceCommentRecord>,
  pageIdMap: PageIdMap,
  userIdMap: UserIdMap,
  /** Called once per comment, right after it is staged (and before its NDJSON line is written), with
   *  both the staged row and the raw source record it came from. Purely an observation hook — nothing
   *  in this function reads its return value — so `importer/runSummary.ts` can fold real-run staging
   *  into its per-item report using the exact same `stageComment` resolution a dry-run validated
   *  against, without this module knowing anything about that shared summary type. */
  onStaged?: (staged: StagedComment, source: SourceCommentRecord) => void
): Promise<CommentsStagingManifest> {
  await fs.mkdir(commentsDir(bundleDir), { recursive: true })

  const lines: string[] = []
  let unresolvedPageIdCount = 0
  for await (const record of comments) {
    const staged = stageComment(record, pageIdMap, userIdMap)
    lines.push(JSON.stringify(staged))
    if (staged.unresolvedPageId) {
      unresolvedPageIdCount++
    }
    onStaged?.(staged, record)
  }

  await fs.writeFile(
    commentsDataPath(bundleDir, siteId),
    lines.length > 0 ? lines.join('\n') + '\n' : '',
    'utf8'
  )

  const manifest: CommentsStagingManifest = {
    schemaVersion: COMMENTS_STAGING_SCHEMA_VERSION,
    siteId,
    rowCount: lines.length,
    unresolvedPageIdCount,
    generatedAt: new Date().toISOString()
  }
  await fs.writeFile(
    commentsManifestPath(bundleDir, siteId),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8'
  )

  return manifest
}

/**
 * Reads back `<bundleDir>/comments/<siteId>.manifest.json` and confirms its schema version is one
 * this reader understands before handing it back.
 *
 * @throws {UnsupportedCommentsStagingSchemaVersionError} if the manifest names a schema version other
 *   than `COMMENTS_STAGING_SCHEMA_VERSION`.
 */
export async function readCommentsStagingManifest(
  bundleDir: string,
  siteId: string
): Promise<CommentsStagingManifest> {
  const raw = await fs.readFile(commentsManifestPath(bundleDir, siteId), 'utf8')
  const manifest = JSON.parse(raw) as CommentsStagingManifest
  if (manifest.schemaVersion !== COMMENTS_STAGING_SCHEMA_VERSION) {
    throw new UnsupportedCommentsStagingSchemaVersionError(manifest.schemaVersion)
  }
  return manifest
}

/**
 * The read side epic 335's future comments-table writer is expected to load against: streams every
 * `StagedComment` staged for `siteId` out of `<bundleDir>/comments/<siteId>.ndjson`, one row per
 * `yield`, after confirming the manifest's schema version and row count both check out.
 *
 * This function does not write to `WIKI.db` or know anything about a `comments` table — see this
 * file's top-of-file doc comment for why that boundary is deliberate.
 *
 * @throws {UnsupportedCommentsStagingSchemaVersionError} via `readCommentsStagingManifest`.
 * @throws {CommentsStagingRowCountMismatchError} if the data file's line count disagrees with the
 *   manifest's `rowCount` — signals a truncated or corrupted staging file rather than a shape this
 *   reader should silently under- or over-read.
 */
export async function* readCommentsStagingBundle(
  bundleDir: string,
  siteId: string
): AsyncIterable<StagedComment> {
  const manifest = await readCommentsStagingManifest(bundleDir, siteId)

  const raw = await fs.readFile(commentsDataPath(bundleDir, siteId), 'utf8')
  const lines = raw.split('\n').filter((line) => line.length > 0)
  if (lines.length !== manifest.rowCount) {
    throw new CommentsStagingRowCountMismatchError(manifest.rowCount, lines.length)
  }

  for (const line of lines) {
    yield JSON.parse(line) as StagedComment
  }
}
