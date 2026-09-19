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
 * A target's sync status at a glance. Deliberately not itself a verdict ("synced" / "never" / "out
 * of date" / "error") -- the caller has the locale strings and relative-time formatting the model
 * has no business deciding, so this hands back the raw ingredients instead.
 */
export interface TargetSyncSummary {
  /** The most recent successful sync to this target, across every content item. */
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
 * Content sync state model
 *
 * Where a sync run last left one (content item, storage target) pairing. A page or asset can have
 * several enabled targets at once, so this is a dedicated table keyed by
 * `(contentType, contentId, targetId)` rather than a jsonb column on `pages`/`assets` -- a single blob
 * per row cannot be keyed by target without hand-rolled merge logic on every write.
 *
 * Only content-level dispatches (`contentType` and `contentId` both present) touch this table at
 * all -- a whole-target action such as `sync` has no single content item to record state against.
 *
 * `contentId` carries no foreign key -- it addresses either `pages` or `assets` depending on
 * `contentType`, and a single uuid column can't reference two tables. That means a row outlives the
 * page or asset it describes: `countOutOfDate` joins outward from `pages`/`assets`, so an orphan
 * simply drops out of its results, but `getTargetSummary`'s error lookup joins through no content at
 * all -- it can surface an orphan's `lastError` until `purgeOrphaned` sweeps it.
 */
class ContentSync {
  /**
   * A target's sync status at a glance: when it last succeeded, its most recent error (if any), and
   * how much content on the site is out of date on it.
   *
   * Aggregate queries rather than every row for the target reduced in memory: a target can have one
   * row per page and asset on the site, and this needs three numbers out of that.
   *
   * **A stale error is suppressed rather than surfaced.** `recordSuccess` only ever clears
   * `lastError` on the *same* content item's own row, so a page that failed once and was never
   * individually retried would otherwise win the "most recently updated row with an error" query
   * forever, long after the target went back to syncing everything else fine. Staleness is therefore
   * judged at the target level: once *any* content item has synced more recently than the error's
   * own `updatedAt`, the target counts as healthy again and the error is hidden. The row itself is
   * left untouched, so it still stands for anyone inspecting that specific item.
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

  /**
   * Record that a sync attempt succeeded, clearing any previous error. Upserts on the
   * `(targetId, contentType, contentId)` unique index, so the first sync of an item creates its row
   * and every one after updates it in place.
   */
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
   * Record that a sync attempt failed. Leaves `lastSyncedAt`/`lastDirection`/`targetRef` untouched --
   * they describe the last *successful* sync, which this attempt was not. Upserts the same way
   * `recordSuccess` does, so an item that has never synced still gets a row saying it was tried.
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
   * Drop every sync-state row for one content item, across every target. Call this when the page or
   * asset itself is deleted -- `contentId` is deliberately not a foreign key, so nothing at the db
   * level cleans this up; this is the compensating delete that design assumed.
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

  /**
   * `forgetContent` for a batch of same-type items in one query -- what a folder deletion's bulk
   * path needs, rather than one query per item.
   */
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

  /**
   * How many content items of one kind are out of date on this target -- their `updatedAt` is newer
   * than their last successful sync to it, including every item that has never synced to it at all.
   *
   * Asks Postgres for `count(*)` over the join rather than selecting a row per match: the caller
   * needs the number, never the ids, and a target can have one row per page and asset on the site.
   */
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
   * Sweeps rows whose `contentId` no longer matches any `pages`/`assets` row -- the backstop for
   * rows the delete path's own cleanup never reached, e.g. one lost to a dispatch that failed
   * partway through. `contentId` is deliberately not a foreign key, so nothing else enforces this.
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
