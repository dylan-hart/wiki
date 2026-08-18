import type { WikiDb } from '../../core/db.ts'
import {
  groups as groupsTable,
  userGroups as userGroupsTable,
  users as usersTable
} from '../../db/schema.ts'
import type { SourceRecord } from '../connector.ts'

/**
 * Users/Groups importer engine (Feature 414, Task 726).
 *
 * Entry point for the part of the 2.5.x → 3.0 migration that writes `groups`, `users` and
 * `userGroups`. Deliberately outside both the request/response path (nothing here is a Fastify
 * route) and `checkForLegacyInstall()` (`core/db.ts`) — that function detects a legacy install
 * during normal boot, whereas this only ever runs when an administrator explicitly launches a
 * migration, which is feature #421's CLI. This module is that CLI's engine, not the CLI itself:
 * it exposes `importUsersAndGroups()` for the CLI to call once it has built a `SourceConnector`
 * and a `UsersGroupsWriter`; nothing here boots a database connection or parses argv.
 *
 * What this task builds:
 * - The three-phase write order (groups → users → userGroups) `importUsersAndGroups()` enforces.
 * - The `Map<number, string>` source-id → target-UUID bookkeeping both `groups` and `users` need,
 *   since 2.5.x uses integer PKs (`increments()`) and 3.0 uses `uuid().defaultRandom()`
 *   (`db/schema.ts` `groups` at line 147, `users` at line 767) — see `2.5x-to-3.0-mapping.md`'s
 *   `userGroups` section, which calls out that `userId`/`groupId` are "remapped through the
 *   [...] old-id → new-UUID table" and that 2.x's own `userGroups.id` has no destination at all
 *   (it's a composite-PK relation table in 3.0, `db/schema.ts` `userGroups` at line 791).
 * - The `UsersGroupsImportResult` shape feature #421's CLI and dry-run report consume.
 *
 * What this task deliberately stubs (real field mapping is a later task under Feature 414):
 * - `convertGroup` / `convertUser`: per-record 2.x row → 3.0 insertable row. The default exports
 *   (`stubConvertGroup`, `stubConvertUser`) flag every record instead of converting it — real
 *   conversion means folding `auth`/`meta`/`prefs` jsonb, resolving `providerKey` to an
 *   `authentication` row UUID, and converting `permissions`/`pageRules` into 3.0's `rules` shape,
 *   none of which belongs here per this task's own description.
 * - The `userGroups` translation itself needs no such stub: per the mapping doc, all it does is
 *   look up both remapped ids and write the join row, which is exactly what `importUsersAndGroups()`
 *   already has to do to satisfy the ordering requirement above. There is no per-record 2.x → 3.0
 *   *field* to convert once the two ids are resolved.
 */

// ---------------------------------------------------------------------------
// Result shape — the contract feature #421's CLI and dry-run report read.
// ---------------------------------------------------------------------------

/** Outcome of attempting to write one source record. */
export type RecordStatus = 'created' | 'skipped' | 'conflicted' | 'flagged'

/** Per-record detail, always present regardless of outcome so a dry-run report can list every row. */
export interface RecordResult {
  /** The record's 2.x integer id (or, for a `userGroups` row lacking one of its own, a synthetic
   * `${userId}:${groupId}` label — see `2.5x-to-3.0-mapping.md`'s note that the join table's own
   * surrogate id has no destination). */
  sourceId: number | string
  /** The row's new UUID, when one was actually written (or would be, in a dry run). */
  targetId?: string
  status: RecordStatus
  /** Human-readable reason, required for every non-`created` status. */
  message?: string
}

/** Aggregate counts plus the per-record detail list for one entity (`groups`, `users`, or `userGroups`). */
export interface EntityImportSummary {
  created: number
  skipped: number
  conflicted: number
  flagged: number
  records: RecordResult[]
}

/** What `importUsersAndGroups()` resolves with — one summary per entity, in write order. */
export interface UsersGroupsImportResult {
  groups: EntityImportSummary
  users: EntityImportSummary
  userGroups: EntityImportSummary
}

function emptySummary(): EntityImportSummary {
  return { created: 0, skipped: 0, conflicted: 0, flagged: 0, records: [] }
}

function record(summary: EntityImportSummary, result: RecordResult): void {
  summary[result.status]++
  summary.records.push(result)
}

// ---------------------------------------------------------------------------
// Per-record conversion — stubbed here, real bodies land in a later Feature 414 task.
// ---------------------------------------------------------------------------

/** What `groupsTable`/`usersTable` actually accept on insert — the shape a real converter must
 * eventually produce; this task only needs the type to thread through the stub signatures below. */
export type NewGroupRow = typeof groupsTable.$inferInsert
export type NewUserRow = typeof usersTable.$inferInsert

/** A conversion either produces an insertable row, or explains why it doesn't. */
export type ConversionOutcome<TRow> =
  | { status: 'created'; row: TRow }
  | { status: 'skipped' | 'conflicted' | 'flagged'; message: string }

export type GroupConverter = (
  source: SourceRecord
) => ConversionOutcome<NewGroupRow> | Promise<ConversionOutcome<NewGroupRow>>

export type UserConverter = (
  source: SourceRecord
) => ConversionOutcome<NewUserRow> | Promise<ConversionOutcome<NewUserRow>>

/** Deferred to a later Feature 414 task — see the module doc's "deliberately stubs" section. */
export const stubConvertGroup: GroupConverter = () => ({
  status: 'flagged',
  message: 'group field mapping not implemented yet (deferred to a later Feature 414 task)'
})

/** Deferred to a later Feature 414 task — see the module doc's "deliberately stubs" section. */
export const stubConvertUser: UserConverter = () => ({
  status: 'flagged',
  message: 'user field mapping not implemented yet (deferred to a later Feature 414 task)'
})

// ---------------------------------------------------------------------------
// Write port — lets orchestration be unit-tested without a live database, and lets the CLI (#421)
// swap in a dry-run writer that never touches Postgres at all.
// ---------------------------------------------------------------------------

export interface UsersGroupsWriter {
  insertGroup(row: NewGroupRow): Promise<{ id: string }>
  insertUser(row: NewUserRow): Promise<{ id: string }>
  insertUserGroup(userId: string, groupId: string): Promise<void>
}

/** Real writer, backed by Drizzle. Any insert failure (e.g. `users.email`'s unique constraint) is
 * surfaced to the caller as a thrown error — `importUsersAndGroups()` catches it per-record and
 * downgrades that record to `conflicted` rather than aborting the whole import. */
export function createDrizzleWriter(db: WikiDb): UsersGroupsWriter {
  return {
    async insertGroup(row) {
      const [inserted] = await db.insert(groupsTable).values(row).returning({ id: groupsTable.id })
      return inserted
    },
    async insertUser(row) {
      const [inserted] = await db.insert(usersTable).values(row).returning({ id: usersTable.id })
      return inserted
    },
    async insertUserGroup(userId, groupId) {
      await db.insert(userGroupsTable).values({ userId, groupId })
    }
  }
}

/** Dry-run writer: mints a placeholder UUID for every record instead of writing anything, so the
 * `userGroups` phase can still resolve cross-references and report what it *would* write. */
export function createDryRunWriter(): UsersGroupsWriter {
  return {
    async insertGroup() {
      return { id: crypto.randomUUID() }
    },
    async insertUser() {
      return { id: crypto.randomUUID() }
    },
    async insertUserGroup() {
      // Nothing to return — a dry run never needs the join row's identity for anything downstream.
    }
  }
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

export interface UsersGroupsImportInput {
  source: {
    groups: AsyncIterable<SourceRecord>
    users: AsyncIterable<SourceRecord>
    /** `userGroups` join rows — see the module doc for why this is a third iterable rather than
     * membership denormalized onto each user record: the source connector interface (#412) exposes
     * only `users()`/`groups()`, so whichever later task implements those bodies is free to hand
     * this engine a `userGroups` iterable built any way it likes, without this orchestration layer
     * having to assume a particular shape for embedded membership. */
    userGroups: AsyncIterable<SourceRecord>
  }
  writer: UsersGroupsWriter
  convertGroup?: GroupConverter
  convertUser?: UserConverter
}

/** Reads a 2.x integer id off a source record, under the given column name. Returns `undefined`
 * (rather than throwing) for a missing/non-numeric value so a malformed record can be reported as
 * `skipped` instead of aborting the whole entity's import. */
function readSourceId(source: SourceRecord, column: string): number | undefined {
  const raw = source[column]
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN
  return Number.isInteger(n) ? n : undefined
}

async function importGroups(
  source: AsyncIterable<SourceRecord>,
  convert: GroupConverter,
  writer: UsersGroupsWriter
): Promise<{ summary: EntityImportSummary; idMap: Map<number, string> }> {
  const summary = emptySummary()
  const idMap = new Map<number, string>()

  for await (const sourceRecord of source) {
    const sourceId = readSourceId(sourceRecord, 'id')
    if (sourceId === undefined) {
      record(summary, {
        sourceId: String(sourceRecord.id ?? '?'),
        status: 'skipped',
        message: 'missing or non-integer source id'
      })
      continue
    }

    const outcome = await convert(sourceRecord)
    if (outcome.status !== 'created') {
      record(summary, { sourceId, status: outcome.status, message: outcome.message })
      continue
    }

    try {
      const { id: targetId } = await writer.insertGroup(outcome.row)
      idMap.set(sourceId, targetId)
      record(summary, { sourceId, targetId, status: 'created' })
    } catch (err: any) {
      record(summary, { sourceId, status: 'conflicted', message: err.message })
    }
  }

  return { summary, idMap }
}

async function importUsers(
  source: AsyncIterable<SourceRecord>,
  convert: UserConverter,
  writer: UsersGroupsWriter
): Promise<{ summary: EntityImportSummary; idMap: Map<number, string> }> {
  const summary = emptySummary()
  const idMap = new Map<number, string>()

  for await (const sourceRecord of source) {
    const sourceId = readSourceId(sourceRecord, 'id')
    if (sourceId === undefined) {
      record(summary, {
        sourceId: String(sourceRecord.id ?? '?'),
        status: 'skipped',
        message: 'missing or non-integer source id'
      })
      continue
    }

    const outcome = await convert(sourceRecord)
    if (outcome.status !== 'created') {
      record(summary, { sourceId, status: outcome.status, message: outcome.message })
      continue
    }

    try {
      const { id: targetId } = await writer.insertUser(outcome.row)
      idMap.set(sourceId, targetId)
      record(summary, { sourceId, targetId, status: 'created' })
    } catch (err: any) {
      record(summary, { sourceId, status: 'conflicted', message: err.message })
    }
  }

  return { summary, idMap }
}

/** Translates and writes `userGroups` join rows, strictly after both id maps are fully populated —
 * the ordering `importUsersAndGroups()` exists to guarantee. No field-mapping stub is needed here (see
 * the module doc): once both ids resolve, there is nothing left to convert. */
async function importUserGroups(
  source: AsyncIterable<SourceRecord>,
  userIdMap: Map<number, string>,
  groupIdMap: Map<number, string>,
  writer: UsersGroupsWriter
): Promise<EntityImportSummary> {
  const summary = emptySummary()

  for await (const sourceRecord of source) {
    const sourceUserId = readSourceId(sourceRecord, 'userId')
    const sourceGroupId = readSourceId(sourceRecord, 'groupId')
    const label = `${sourceRecord.userId ?? '?'}:${sourceRecord.groupId ?? '?'}`

    if (sourceUserId === undefined || sourceGroupId === undefined) {
      record(summary, {
        sourceId: label,
        status: 'skipped',
        message: 'missing or non-integer userId/groupId'
      })
      continue
    }

    const targetUserId = userIdMap.get(sourceUserId)
    const targetGroupId = groupIdMap.get(sourceGroupId)
    if (!targetUserId || !targetGroupId) {
      const missing =
        !targetUserId && !targetGroupId ? 'user and group' : !targetUserId ? 'user' : 'group'
      record(summary, {
        sourceId: `${sourceUserId}:${sourceGroupId}`,
        status: 'skipped',
        message: `referenced ${missing} was not created, so this membership was not written`
      })
      continue
    }

    try {
      await writer.insertUserGroup(targetUserId, targetGroupId)
      record(summary, { sourceId: `${sourceUserId}:${sourceGroupId}`, status: 'created' })
    } catch (err: any) {
      record(summary, {
        sourceId: `${sourceUserId}:${sourceGroupId}`,
        status: 'conflicted',
        message: err.message
      })
    }
  }

  return summary
}

/**
 * Runs the full Users/Groups import: groups, then users, then `userGroups` — in that order, and
 * only that order, because `userGroups` translation needs both id maps fully built first (a group
 * referenced by a not-yet-imported user, or vice versa, is impossible by construction here since
 * neither map is read until its own phase has completely finished).
 */
export async function importUsersAndGroups(
  input: UsersGroupsImportInput
): Promise<UsersGroupsImportResult> {
  const convertGroup = input.convertGroup ?? stubConvertGroup
  const convertUser = input.convertUser ?? stubConvertUser

  const groupsResult = await importGroups(input.source.groups, convertGroup, input.writer)
  const usersResult = await importUsers(input.source.users, convertUser, input.writer)
  const userGroupsSummary = await importUserGroups(
    input.source.userGroups,
    usersResult.idMap,
    groupsResult.idMap,
    input.writer
  )

  return {
    groups: groupsResult.summary,
    users: usersResult.summary,
    userGroups: userGroupsSummary
  }
}
