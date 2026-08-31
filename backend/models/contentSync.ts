import { and, desc, eq, gt, isNotNull, isNull, or, sql } from 'drizzle-orm'
import {
  assets as assetsTable,
  contentSyncState as contentSyncStateTable,
  pages as pagesTable
} from '../db/schema.ts'

/** The kinds of content that can have sync state, i.e. that a storage target can hold. */
export const SYNC_CONTENT_TYPES = ['page', 'asset'] as const
export type SyncContentType = (typeof SYNC_CONTENT_TYPES)[number]

/** Direction a sync attempt moved content in, once it has succeeded at least once. */
export const SYNC_DIRECTIONS = ['push', 'pull'] as const
export type SyncDirection = (typeof SYNC_DIRECTIONS)[number]

/** A `contentSyncState` row, as read back. */
export interface ContentSyncStateRow {
  id: string
  contentType: SyncContentType
  contentId: string
  targetId: string
  lastDirection: SyncDirection | null
  targetRef: unknown
  lastSyncedAt: Date | null
  lastError: string | null
  createdAt: Date
  updatedAt: Date
}

/** One content item the out-of-date query found, i.e. it has no successful sync newer than itself. */
export interface OutOfDateContent {
  id: string
  siteId: string
  updatedAt: Date
}

/**
 * A target's sync status at a glance, e.g. for the admin area's per-target status card. Deliberately
 * not itself a verdict ("synced" / "never" / "out of date" / "error") -- the caller has locale strings
 * and relative-time formatting the model has no business deciding, so this hands back the raw
 * ingredients instead.
 */
export interface TargetSyncSummary {
  /** The most recent successful sync to this target, across every content item, or null for none yet. */
  lastSyncedAt: string | null
  /**
   * The error from the most recently updated row that has one — unless a *different* content item on
   * this target has since synced successfully, in which case it is stale and this is null instead. See
   * `getTargetSummary` for why "stale" is judged against the target's overall `lastSyncedAt` rather
   * than only against a retry of that exact item (OpenProject #823 item 6 / upstream #846).
   */
  lastError: string | null
  /** When that error happened, i.e. the same row's `updatedAt`. Null exactly when `lastError` is. */
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
 * `recordSuccess`/`recordFailure` are called by `tasks/simple/dispatch-storage.ts` -- queued by
 * `models/storage.ts#dispatch()` for every enabled non-pull target whose module has
 * `supportsContentSync`, one job per (content item, target) pairing. `recordSuccess` stamps
 * `lastSyncedAt`/`lastDirection`/`targetRef` and clears any previous error; `recordFailure` leaves
 * those success fields untouched and stores `lastError` instead. Both upsert on the
 * `(targetId, contentType, contentId)` unique index, so the first attempt for a pairing creates its
 * row and every one after updates it in place. Only content-level dispatches (`contentType` and
 * `contentId` both present) touch this table at all -- a whole-target action such as `sync` has no
 * single content item to record state against and skips this step entirely (see
 * `DispatchStoragePayload`).
 *
 * `contentId` carries no foreign key -- it addresses either `pages` or `assets` depending on
 * `contentType`, and a single uuid column can't reference two tables. That means a row is never
 * reclaimed when the page or asset it describes is deleted: `getOutOfDatePages`/`getOutOfDateAssets`
 * join outward from `pages`/`assets`, so a deleted content item's orphaned row simply drops out of
 * those results, but `getTargetSummary`'s error-lookup query does not join through content at all --
 * it can surface a stale row's `lastError` for a page or asset that no longer exists.
 */
class ContentSync {
  /**
   * The sync state for one content item on one target, or null if it has never been attempted.
   */
  async getState(
    contentType: SyncContentType,
    contentId: string,
    targetId: string
  ): Promise<ContentSyncStateRow | null> {
    const rows = await WIKI.db
      .select()
      .from(contentSyncStateTable)
      .where(
        and(
          eq(contentSyncStateTable.contentType, contentType),
          eq(contentSyncStateTable.contentId, contentId),
          eq(contentSyncStateTable.targetId, targetId)
        )
      )
      .limit(1)
    return (rows[0] as ContentSyncStateRow) ?? null
  }

  /**
   * Every target's state for one content item, e.g. for a page's "sync status" panel.
   */
  async getStatesForContent(
    contentType: SyncContentType,
    contentId: string
  ): Promise<ContentSyncStateRow[]> {
    return (await WIKI.db
      .select()
      .from(contentSyncStateTable)
      .where(
        and(
          eq(contentSyncStateTable.contentType, contentType),
          eq(contentSyncStateTable.contentId, contentId)
        )
      )) as ContentSyncStateRow[]
  }

  /**
   * Every content item's state on one target, e.g. for a target's "last synced" admin listing.
   */
  async getStatesForTarget(targetId: string): Promise<ContentSyncStateRow[]> {
    return (await WIKI.db
      .select()
      .from(contentSyncStateTable)
      .where(eq(contentSyncStateTable.targetId, targetId))) as ContentSyncStateRow[]
  }

  /**
   * A target's sync status at a glance: when it last succeeded, its most recent error (if any), and
   * how much content on the site is out of date on it. What the admin area's per-target status card
   * reads -- see `TargetSyncSummary` for why this stops short of a single verdict.
   *
   * Four aggregate queries rather than `getStatesForTarget()`/`getOutOfDatePages()`/`getOutOfDateAssets()`
   * reduced in memory: a target can have one row per page and asset on the site, and a status card needs
   * three numbers out of that, not every row transferred to compute them -- `countOutOfDatePages()` and
   * `countOutOfDateAssets()` run the identical LEFT JOIN as their row-returning counterparts but ask
   * Postgres for `count(*)` instead of selecting `{ id, siteId, updatedAt }` for every match.
   *
   * **A stale error is suppressed rather than surfaced (OpenProject #823 item 6 / upstream #846).**
   * `recordSuccess` only ever clears `lastError` on the *same* content item's own row (see its doc) --
   * so a page that failed once and was never individually retried keeps a permanent `lastError` on its
   * row even though the target as a whole may since be syncing everything else fine. Left unchecked,
   * that single stuck row would win the "most recently updated row with an error" query forever and the
   * admin area's status card would show a dead error banner indefinitely, exactly the bug report: "the
   * storage-target status UI keeps showing an old error banner after a later sync succeeds." The fix
   * judges staleness at the target level, not the row level -- once *any* content item has synced to
   * this target more recently than the error's own `updatedAt`, that is taken as evidence the target
   * itself is healthy again (the outage/misconfiguration the error reported has passed) and the error is
   * hidden. The row itself is left untouched: `getStatesForTarget`/`getState` still report it for anyone
   * inspecting that specific item, and it becomes live again in the summary if the target's overall
   * `lastSyncedAt` somehow regresses (which the current callers never allow, so in practice it does not
   * recur), but its retirement is not lost either.
   */
  async getTargetSummary(
    targetId: string,
    { siteId }: { siteId?: string } = {}
  ): Promise<TargetSyncSummary> {
    const [[syncedRow], [errorRow], outOfDatePagesCount, outOfDateAssetsCount] = await Promise.all([
      WIKI.db
        .select({ lastSyncedAt: sql<Date | null>`max(${contentSyncStateTable.lastSyncedAt})` })
        .from(contentSyncStateTable)
        .where(eq(contentSyncStateTable.targetId, targetId)),
      WIKI.db
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
      this.countOutOfDatePages(targetId, { siteId }),
      this.countOutOfDateAssets(targetId, { siteId })
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
   * Record that a sync attempt succeeded: stamps `lastSyncedAt` to now (or `syncedAt`, if given),
   * stores the direction and the target's opaque ref, and clears any previous error.
   *
   * Upserts on the `(targetId, contentType, contentId)` unique index, so the first sync of an item
   * creates its row and every one after updates it in place.
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
    // NOTE: an ISO string, not a Date, is passed deliberately -- see the same note in models/jobs.ts.
    const lastSyncedAt = syncedAt.toString({ smallestUnit: 'millisecond' }) as any
    const values = {
      lastDirection: direction,
      targetRef: targetRef ?? null,
      lastSyncedAt,
      lastError: null
    }
    await WIKI.db
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
   * they describe the last *successful* sync, which this attempt was not -- and stores the error.
   *
   * Upserts the same way `recordSuccess` does, so an item that has never synced successfully still
   * gets a row recording that it was tried and failed.
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
    await WIKI.db
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
   * Pages whose `updatedAt` is newer than their last successful sync to this target -- including
   * every page that has never synced to it at all. What a dispatcher asks before pushing a batch.
   */
  async getOutOfDatePages(
    targetId: string,
    { siteId }: { siteId?: string } = {}
  ): Promise<OutOfDateContent[]> {
    const conditions = [siteId ? eq(pagesTable.siteId, siteId) : undefined].filter((c) => c != null)
    return WIKI.db
      .select({ id: pagesTable.id, siteId: pagesTable.siteId, updatedAt: pagesTable.updatedAt })
      .from(pagesTable)
      .leftJoin(
        contentSyncStateTable,
        and(
          eq(contentSyncStateTable.contentType, 'page'),
          eq(contentSyncStateTable.contentId, pagesTable.id),
          eq(contentSyncStateTable.targetId, targetId)
        )
      )
      .where(
        and(
          ...conditions,
          or(
            isNull(contentSyncStateTable.lastSyncedAt),
            gt(pagesTable.updatedAt, contentSyncStateTable.lastSyncedAt)
          )
        )
      )
  }

  /**
   * Assets whose `updatedAt` is newer than their last successful sync to this target -- the same
   * query as `getOutOfDatePages`, over the other content type.
   */
  async getOutOfDateAssets(
    targetId: string,
    { siteId }: { siteId?: string } = {}
  ): Promise<OutOfDateContent[]> {
    const conditions = [siteId ? eq(assetsTable.siteId, siteId) : undefined].filter(
      (c) => c != null
    )
    return WIKI.db
      .select({ id: assetsTable.id, siteId: assetsTable.siteId, updatedAt: assetsTable.updatedAt })
      .from(assetsTable)
      .leftJoin(
        contentSyncStateTable,
        and(
          eq(contentSyncStateTable.contentType, 'asset'),
          eq(contentSyncStateTable.contentId, assetsTable.id),
          eq(contentSyncStateTable.targetId, targetId)
        )
      )
      .where(
        and(
          ...conditions,
          or(
            isNull(contentSyncStateTable.lastSyncedAt),
            gt(assetsTable.updatedAt, contentSyncStateTable.lastSyncedAt)
          )
        )
      )
  }

  /**
   * How many pages are out of date on this target -- the same LEFT JOIN condition as
   * `getOutOfDatePages`, but asking Postgres for `count(*)` over it instead of transferring
   * `{ id, siteId, updatedAt }` for every matching row. What `getTargetSummary` calls: it only ever
   * needs the number, never the ids.
   */
  async countOutOfDatePages(
    targetId: string,
    { siteId }: { siteId?: string } = {}
  ): Promise<number> {
    const conditions = [siteId ? eq(pagesTable.siteId, siteId) : undefined].filter((c) => c != null)
    const outOfDatePages = WIKI.db
      .select({ id: pagesTable.id })
      .from(pagesTable)
      .leftJoin(
        contentSyncStateTable,
        and(
          eq(contentSyncStateTable.contentType, 'page'),
          eq(contentSyncStateTable.contentId, pagesTable.id),
          eq(contentSyncStateTable.targetId, targetId)
        )
      )
      .where(
        and(
          ...conditions,
          or(
            isNull(contentSyncStateTable.lastSyncedAt),
            gt(pagesTable.updatedAt, contentSyncStateTable.lastSyncedAt)
          )
        )
      )
      .as('out_of_date_pages')
    return WIKI.db.$count(outOfDatePages)
  }

  /**
   * How many assets are out of date on this target -- the same LEFT JOIN condition as
   * `getOutOfDateAssets`, counted rather than fetched. See `countOutOfDatePages` for why.
   */
  async countOutOfDateAssets(
    targetId: string,
    { siteId }: { siteId?: string } = {}
  ): Promise<number> {
    const conditions = [siteId ? eq(assetsTable.siteId, siteId) : undefined].filter(
      (c) => c != null
    )
    const outOfDateAssets = WIKI.db
      .select({ id: assetsTable.id })
      .from(assetsTable)
      .leftJoin(
        contentSyncStateTable,
        and(
          eq(contentSyncStateTable.contentType, 'asset'),
          eq(contentSyncStateTable.contentId, assetsTable.id),
          eq(contentSyncStateTable.targetId, targetId)
        )
      )
      .where(
        and(
          ...conditions,
          or(
            isNull(contentSyncStateTable.lastSyncedAt),
            gt(assetsTable.updatedAt, contentSyncStateTable.lastSyncedAt)
          )
        )
      )
      .as('out_of_date_assets')
    return WIKI.db.$count(outOfDateAssets)
  }
}

export const contentSync = new ContentSync()
