import { and, desc, eq, gt, inArray, isNotNull, isNull, notExists, or, sql } from 'drizzle-orm'
import {
  assets as assetsTable,
  contentSyncState as contentSyncStateTable,
  pages as pagesTable
} from '../db/schema.ts'

const SYNC_CONTENT_TYPES = ['page', 'asset'] as const
export type SyncContentType = (typeof SYNC_CONTENT_TYPES)[number]

const SYNC_DIRECTIONS = ['push', 'pull'] as const
export type SyncDirection = (typeof SYNC_DIRECTIONS)[number]

/**
 * Deliberately not itself a verdict ("synced" / "never" / "out of date" / "error") -- the caller has
 * the locale strings and relative-time formatting the model has no business deciding.
 */
export interface TargetSyncSummary {
  lastSyncedAt: string | null
  /**
   * The error from the most recently updated row that has one — unless a *different* content item on
   * this target has since synced successfully, in which case it is stale and this is null instead.
   */
  lastError: string | null
  /** The same row's `updatedAt`. Null exactly when `lastError` is. */
  lastAttemptAt: string | null
  /** Pages plus assets with no successful sync to this target newer than their own last edit. */
  outOfDateCount: number
}

/**
 * Where a sync run last left one (content item, storage target) pairing: a dedicated table keyed by
 * `(contentType, contentId, targetId)` rather than a jsonb column on `pages`/`assets`, because one
 * item can have several enabled targets at once and a single blob per row cannot be keyed by target
 * without hand-rolled merge logic on every write.
 *
 * Only content-level dispatches (`contentType` and `contentId` both present) touch this table at
 * all -- a whole-target action such as `sync` has no single content item to record state against.
 *
 * `contentId` carries no foreign key: one uuid column cannot reference both `pages` and `assets`.
 * A row therefore outlives the item it describes -- `countOutOfDate` joins outward from the content
 * table so an orphan drops out of its results, but `getTargetSummary`'s error lookup joins through
 * no content at all and can surface an orphan's `lastError` until `purgeOrphaned` sweeps it.
 */
class ContentSync {
  /**
   * Aggregate queries rather than every row for the target reduced in memory: a target can have one
   * row per page and asset on the site, and this needs three numbers out of that.
   *
   * **A stale error is suppressed rather than surfaced.** `recordSuccess` only ever clears
   * `lastError` on the *same* content item's own row, so a page that failed once and was never
   * individually retried would otherwise win the "most recently updated row with an error" query
   * forever. Staleness is therefore judged at the target level: once *any* content item has synced
   * more recently than the error's own `updatedAt`, the error is hidden. The row itself is left
   * untouched, so it still stands for anyone inspecting that specific item.
   */
  async getTargetSummary(
    targetId: string,
    { siteId }: { siteId?: string } = {}
  ): Promise<TargetSyncSummary> {
    const [[syncedRow], [errorRow], outOfDatePagesCount, outOfDateAssetsCount] = await Promise.all([
      CARDINAL.db
        .select({
          // -> `.mapWith(...)` reuses the column's own decoder: a raw `sql` fragment has no column
          //    of its own for drizzle's node-postgres driver to look a decoder up from, so without
          //    it the aggregate comes back as the undecoded wire string rather than a `Date` and the
          //    `.toISOString()` below throws.
          lastSyncedAt: sql<Date | null>`max(${contentSyncStateTable.lastSyncedAt})`.mapWith(
            contentSyncStateTable.lastSyncedAt
          )
        })
        .from(contentSyncStateTable)
        .where(eq(contentSyncStateTable.targetId, targetId)),
      CARDINAL.db
        .select({
          lastError: contentSyncStateTable.lastError,
          updatedAt: contentSyncStateTable.updatedAt
        })
        .from(contentSyncStateTable)
        .where(
          and(
            eq(contentSyncStateTable.targetId, targetId),
            isNotNull(contentSyncStateTable.lastError)
          )
        )
        .orderBy(desc(contentSyncStateTable.updatedAt))
        .limit(1),
      this.countOutOfDate('page', targetId, { siteId }),
      this.countOutOfDate('asset', targetId, { siteId })
    ])

    const lastSyncedAt = syncedRow?.lastSyncedAt ?? null
    const errorIsStale =
      errorRow != null && lastSyncedAt != null && lastSyncedAt > errorRow.updatedAt

    return {
      lastSyncedAt: lastSyncedAt ? lastSyncedAt.toISOString() : null,
      lastError: errorIsStale ? null : (errorRow?.lastError ?? null),
      lastAttemptAt: errorIsStale || !errorRow ? null : errorRow.updatedAt.toISOString(),
      outOfDateCount: outOfDatePagesCount + outOfDateAssetsCount
    }
  }

  async recordSuccess({
    contentType,
    contentId,
    targetId,
    direction,
    targetRef = null,
    syncedAt = Temporal.Now.instant()
  }: {
    contentType: SyncContentType
    contentId: string
    targetId: string
    direction: SyncDirection
    targetRef?: unknown
    syncedAt?: Temporal.Instant
  }): Promise<void> {
    // NOTE: an ISO string, not a Date -- pg sends it verbatim for postgres to parse as UTC, where
    // a Date would go over in the process's local timezone. The cast only silences the column type.
    const lastSyncedAt = syncedAt.toString({ smallestUnit: 'millisecond' }) as any
    const values = {
      lastDirection: direction,
      targetRef: targetRef ?? null,
      lastSyncedAt,
      lastError: null
    }
    await CARDINAL.db
      .insert(contentSyncStateTable)
      .values({ contentType, contentId, targetId, ...values })
      .onConflictDoUpdate({
        target: [
          contentSyncStateTable.targetId,
          contentSyncStateTable.contentType,
          contentSyncStateTable.contentId
        ],
        set: { ...values, updatedAt: sql`now()` }
      })
  }

  /**
   * Leaves `lastSyncedAt`/`lastDirection`/`targetRef` untouched -- they describe the last
   * *successful* sync, which this attempt was not. The upsert means an item that has never synced
   * still gets a row saying it was tried.
   */
  async recordFailure({
    contentType,
    contentId,
    targetId,
    error
  }: {
    contentType: SyncContentType
    contentId: string
    targetId: string
    error: string
  }): Promise<void> {
    await CARDINAL.db
      .insert(contentSyncStateTable)
      .values({ contentType, contentId, targetId, lastError: error })
      .onConflictDoUpdate({
        target: [
          contentSyncStateTable.targetId,
          contentSyncStateTable.contentType,
          contentSyncStateTable.contentId
        ],
        set: { lastError: error, updatedAt: sql`now()` }
      })
  }

  /**
   * The compensating delete a page or asset deletion has to call: with no foreign key on
   * `contentId`, nothing at the db level cleans these rows up.
   */
  async forgetContent(contentType: SyncContentType, contentId: string): Promise<void> {
    await CARDINAL.db
      .delete(contentSyncStateTable)
      .where(
        and(
          eq(contentSyncStateTable.contentType, contentType),
          eq(contentSyncStateTable.contentId, contentId)
        )
      )
  }

  async forgetContentBatch(contentType: SyncContentType, contentIds: string[]): Promise<void> {
    if (contentIds.length < 1) {
      return
    }
    await CARDINAL.db
      .delete(contentSyncStateTable)
      .where(
        and(
          eq(contentSyncStateTable.contentType, contentType),
          inArray(contentSyncStateTable.contentId, contentIds)
        )
      )
  }

  async countOutOfDate(
    contentType: SyncContentType,
    targetId: string,
    { siteId }: { siteId?: string } = {}
  ): Promise<number> {
    const contentTable = contentType === 'page' ? pagesTable : assetsTable
    const conditions = [siteId ? eq(contentTable.siteId, siteId) : undefined].filter(
      (c) => c != null
    )
    const outOfDate = CARDINAL.db
      .select({ id: contentTable.id })
      .from(contentTable)
      .leftJoin(
        contentSyncStateTable,
        and(
          eq(contentSyncStateTable.contentType, contentType),
          eq(contentSyncStateTable.contentId, contentTable.id),
          eq(contentSyncStateTable.targetId, targetId)
        )
      )
      .where(
        and(
          ...conditions,
          or(
            isNull(contentSyncStateTable.lastSyncedAt),
            gt(contentTable.updatedAt, contentSyncStateTable.lastSyncedAt)
          )
        )
      )
      .as('out_of_date_content')
    return CARDINAL.db.$count(outOfDate)
  }

  /**
   * The backstop for rows the delete path's own cleanup never reached -- one lost to a dispatch
   * that failed partway through, say.
   */
  async purgeOrphaned(): Promise<number> {
    const result = await CARDINAL.db.delete(contentSyncStateTable).where(
      or(
        and(
          eq(contentSyncStateTable.contentType, 'page'),
          notExists(
            CARDINAL.db
              .select({ exists: sql`1` })
              .from(pagesTable)
              .where(eq(pagesTable.id, contentSyncStateTable.contentId))
          )
        ),
        and(
          eq(contentSyncStateTable.contentType, 'asset'),
          notExists(
            CARDINAL.db
              .select({ exists: sql`1` })
              .from(assetsTable)
              .where(eq(assetsTable.id, contentSyncStateTable.contentId))
          )
        )
      )
    )
    return result.rowCount ?? 0
  }
}

export const contentSync = new ContentSync()
