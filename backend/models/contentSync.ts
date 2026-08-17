import { and, eq, gt, isNull, or, sql } from 'drizzle-orm'
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
 * Content sync state model
 *
 * Where a sync run last left one (content item, storage target) pairing. A page or asset can have
 * several enabled targets at once, so this is a dedicated table keyed by
 * `(contentType, contentId, targetId)` rather than a jsonb column on `pages`/`assets` -- a single blob
 * per row cannot be keyed by target without hand-rolled merge logic on every write.
 *
 * Nothing calls `recordSuccess`/`recordFailure` yet: no storage module dispatches content to a target
 * (see `models/storage.ts`), so this is the state a dispatcher will read and write once one exists.
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
}

export const contentSync = new ContentSync()
