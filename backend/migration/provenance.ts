import { and, eq } from 'drizzle-orm'
import {
  migrationRecords,
  pages as pagesTable,
  tree as treeTable,
  users as usersTable
} from '../db/schema.ts'
import type { WikiDb } from '../core/db.ts'

/**
 * Provenance tracking for idempotent migration re-runs — Feature 421 task 746.
 *
 * `migrationRecords` (`../db/schema.ts`) is the only thing that lets a re-run of the migration CLI
 * tell "already imported" apart from "genuinely new" without comparing every field of every row. Every
 * importer phase (Features 414/416/418/420) is expected to route its writes through `lookupOrInsert()`
 * below rather than inserting directly.
 *
 * ## The interrupted-run edge case (read this before skipping the natural-key fallback)
 *
 * The provenance row for one imported record is written *after* the destination row it describes —
 * there is no way to make both writes atomic across two different tables without wrapping an entire
 * phase in one transaction, and that would mean one bad record aborts every record after it, which is
 * worse. That leaves exactly one window in which a duplicate can slip in: a prior run created the
 * destination row, then the process died — killed, crashed, host rebooted — before it got to write the
 * matching `migrationRecords` row. The next run's exact-key lookup finds nothing for that source row
 * and, with nothing else to go on, would create a second copy of it.
 *
 * `findByNaturalKey` closes that window. Before falling through to `create()`, `lookupOrInsert` asks
 * the destination table itself whether a row already exists there by whatever key genuinely identifies
 * the same real-world entity regardless of *how* it got there — an email address for a user, a
 * `(siteId, locale, path)` for a page, a `(siteId, folderPath, fileName)` for an asset. A hit means the
 * row is already there; this backfills the missing provenance record so every *later* run hits the
 * fast exact-key path, and treats the record the same as an exact-key hit from here on.
 *
 * This is deliberately the fallback, not the primary check: the provenance table is exact and O(1) on
 * its unique index, while a natural-key comparison is one extra query per record, and for an entity
 * with no naturally-unique real-world key at all (a group's name is not guaranteed unique, for
 * instance) there is nothing to fall back to — a caller that omits `findByNaturalKey` gets exactly
 * today's behavior, an exact-key miss falls straight through to `create()`.
 */

/** Identifies one source row, scoped to the destination site — the exact lookup key into
 * `migrationRecords`, matching its `migrationRecords_source_idx` unique index column-for-column. */
export interface MigrationRecordKey {
  siteId: string
  sourceSystem: string
  sourceTable: string
  sourceId: string
}

/** One row of `migrationRecords`, as read back. */
export interface MigrationRecord extends MigrationRecordKey {
  destTable: string
  destId: string
  importedAt: Date
}

/**
 * The `sourceSystem` every phase in this codebase writes today. A constant rather than each phase
 * inventing its own string: two connector kinds (`postgres` vs `export-bundle`) reading the same 2.5.x
 * install are the same source system for idempotency purposes, so this is deliberately not
 * `ctx.source.kind`.
 */
export const SOURCE_SYSTEM_WIKIJS_2_5X = 'wikijs-2.5x'

/**
 * The provenance table plus the natural-key finders `lookupOrInsert`'s fallback needs, bundled so a
 * phase (or a test) only has to carry one object rather than a `WikiDb` plus a handful of loose
 * functions. `createProvenanceStore()` below is the real, `WikiDb`-backed implementation; a test
 * builds its own in-memory implementation of this same interface instead of faking a `WikiDb`.
 */
export interface ProvenanceStore {
  /** Exact lookup by `MigrationRecordKey`, the primary check every `lookupOrInsert` call starts with. */
  find(key: MigrationRecordKey): Promise<MigrationRecord | undefined>
  /** Records that one source row now maps to one destination row. Never overwrites an existing
   * mapping for the same key — a race between two runs both finding no mapping is exactly the
   * interrupted-run scenario the natural-key fallback exists for, and whichever insert loses just
   * means the other run's mapping is the one of record, which is correct since both point at the same
   * real-world entity. */
  record(entry: MigrationRecordKey & { destTable: string; destId: string }): Promise<void>
  /** Natural-key fallback for a 3.0 `users` row: unique on `email`. */
  findExistingUserByEmail(email: string): Promise<string | undefined>
  /** Natural-key fallback for a 3.0 `pages` row: unique on `(siteId, locale, path)`. */
  findExistingPageByPath(siteId: string, locale: string, path: string): Promise<string | undefined>
  /** Natural-key fallback for a 3.0 asset: a `tree` row of `type: 'asset'`, unique on
   * `(siteId, folderPath, fileName)`. `tree.id` doubles as the asset's own id — see
   * `models/assets.ts`'s `upload()`, which inserts the `assets` row under the `tree` row's own id. */
  findExistingAssetByFolderAndFilename(
    siteId: string,
    folderPath: string,
    fileName: string
  ): Promise<string | undefined>
}

/** Builds the real `ProvenanceStore`, backed by the given `WikiDb` (always the 3.0 destination —
 * never the 2.x source, which is read through `SourceConnector` instead). */
export function createProvenanceStore(db: WikiDb): ProvenanceStore {
  return {
    async find(key) {
      const [row] = await db
        .select()
        .from(migrationRecords)
        .where(
          and(
            eq(migrationRecords.siteId, key.siteId),
            eq(migrationRecords.sourceSystem, key.sourceSystem),
            eq(migrationRecords.sourceTable, key.sourceTable),
            eq(migrationRecords.sourceId, key.sourceId)
          )
        )
        .limit(1)
      return row
    },
    async record(entry) {
      await db.insert(migrationRecords).values(entry).onConflictDoNothing()
    },
    async findExistingUserByEmail(email) {
      const [row] = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.email, email))
        .limit(1)
      return row?.id
    },
    async findExistingPageByPath(siteId, locale, path) {
      const [row] = await db
        .select({ id: pagesTable.id })
        .from(pagesTable)
        .where(
          and(
            eq(pagesTable.siteId, siteId),
            eq(pagesTable.locale, locale),
            eq(pagesTable.path, path)
          )
        )
        .limit(1)
      return row?.id
    },
    async findExistingAssetByFolderAndFilename(siteId, folderPath, fileName) {
      const [row] = await db
        .select({ id: treeTable.id })
        .from(treeTable)
        .where(
          and(
            eq(treeTable.siteId, siteId),
            eq(treeTable.type, 'asset'),
            eq(treeTable.folderPath, folderPath),
            eq(treeTable.fileName, fileName)
          )
        )
        .limit(1)
      return row?.id
    }
  }
}

/** What `lookupOrInsert` found, before deciding what (if anything) to do about it. Exported so
 * `resolveExisting` and `lookupOrInsert` share one shape; most callers only need `lookupOrInsert`. */
export interface ExistingMapping {
  destId: string
  /** True when this was found only via the natural-key fallback, not an exact provenance-table hit —
   * i.e. this is the interrupted-run case the module doc describes. */
  viaNaturalKey: boolean
}

/**
 * The read-only half of `lookupOrInsert`: is this source row already mapped to a destination row,
 * checking the exact provenance key first and the natural-key fallback (when given) second? Never
 * writes anything, so it is safe to call during a dry run, unlike `lookupOrInsert` itself (which
 * creates/updates a real destination row on a miss/hit respectively).
 */
export async function resolveExisting(
  store: Pick<ProvenanceStore, 'find'>,
  key: MigrationRecordKey,
  findByNaturalKey?: () => Promise<string | undefined>
): Promise<ExistingMapping | undefined> {
  const existing = await store.find(key)
  if (existing) {
    return { destId: existing.destId, viaNaturalKey: false }
  }
  if (findByNaturalKey) {
    const destId = await findByNaturalKey()
    if (destId) {
      return { destId, viaNaturalKey: true }
    }
  }
  return undefined
}

/** Backfills the provenance row for a mapping `resolveExisting` found only via the natural-key
 * fallback, so a later run hits the fast exact-key path instead of walking the fallback again. Not
 * called for a dry run — see the module doc: this is a write, just a reconciling one rather than a
 * new destination row. */
export async function reconcileNaturalKeyMatch(
  store: Pick<ProvenanceStore, 'record'>,
  key: MigrationRecordKey,
  destTable: string,
  destId: string
): Promise<void> {
  await store.record({ ...key, destTable, destId })
}

export interface LookupOrInsertOptions extends MigrationRecordKey {
  destTable: string
  /** See the module doc's "interrupted-run edge case" section. Omit when the entity has no
   * naturally-unique real-world key to fall back to — a miss then falls straight through to
   * `create()`, same as if this option did not exist. */
  findByNaturalKey?: () => Promise<string | undefined>
  /** Creates the destination row and returns its id. Only called when no existing mapping (by
   * provenance record or natural-key fallback) was found. */
  create: () => Promise<string>
  /** Called instead of doing nothing when an existing mapping was found and `updateExisting` is true. */
  update?: (destId: string) => Promise<void>
  /** Whether an existing mapping should be updated in place rather than left as-is — the CLI's
   * `--update-existing` flag, threaded down via `MigrationContext.updateExisting`. Defaults to `false`
   * (skip), matching the task's own default. */
  updateExisting?: boolean
}

export type LookupOrInsertAction = 'created' | 'skipped' | 'updated'

export interface LookupOrInsertResult {
  destId: string
  action: LookupOrInsertAction
  /** True when the existing mapping was found only via the natural-key fallback and has just been
   * backfilled into `migrationRecords` — surfaced so a caller can log/count the reconciliation
   * distinctly from an ordinary repeat-run skip/update. */
  reconciledViaNaturalKey: boolean
}

/**
 * The lookup-or-insert helper every importer write path (Features 414/416/418/420) is expected to call
 * before creating a destination row, so that re-running the migration CLI against the same source and
 * destination is idempotent instead of duplicating every row on every run. See the module doc for the
 * natural-key fallback this composes in (`resolveExisting` + `reconcileNaturalKeyMatch`) and why it
 * exists.
 *
 * - An exact provenance-table hit, or a natural-key fallback hit (which this backfills into
 *   `migrationRecords` first): skipped by default, or `update(destId)` when `updateExisting` is true.
 * - No hit anywhere: `create()` is called, and the resulting id is recorded so the next run's exact-key
 *   lookup finds it directly.
 */
export async function lookupOrInsert(
  store: ProvenanceStore,
  options: LookupOrInsertOptions
): Promise<LookupOrInsertResult> {
  const existing = await resolveExisting(store, options, options.findByNaturalKey)
  if (existing) {
    if (existing.viaNaturalKey) {
      await reconcileNaturalKeyMatch(store, options, options.destTable, existing.destId)
    }
    if (options.updateExisting && options.update) {
      await options.update(existing.destId)
      return {
        destId: existing.destId,
        action: 'updated',
        reconciledViaNaturalKey: existing.viaNaturalKey
      }
    }
    return {
      destId: existing.destId,
      action: 'skipped',
      reconciledViaNaturalKey: existing.viaNaturalKey
    }
  }

  const destId = await options.create()
  await store.record({
    siteId: options.siteId,
    sourceSystem: options.sourceSystem,
    sourceTable: options.sourceTable,
    sourceId: options.sourceId,
    destTable: options.destTable,
    destId
  })
  return { destId, action: 'created', reconciledViaNaturalKey: false }
}
