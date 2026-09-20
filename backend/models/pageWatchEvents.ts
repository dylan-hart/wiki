import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import { pageWatchEvents as pageWatchEventsTable, pages as pagesTable } from '../db/schema.ts'
import type { WatchNotifyMode } from './pageWatching.ts'

/**
 * `suggestApproved`/`suggestDeclined` address a submission's author directly
 * (`models/approvals.ts#notifySubmissionAuthor`), bypassing `pageWatching.listWatchers()` and its
 * preference filtering, rather than being resolved from who watches the page. Names are kept short:
 * `action` is a `varchar(16)` column.
 */
export type PageWatchNotifiableAction =
  | 'updated'
  | 'moved'
  | 'deleted'
  | 'suggestApproved'
  | 'suggestDeclined'

export interface PendingWatchEvent {
  siteId: string
  pageId: string
  /** Captured as of this change: the page may be renamed, moved or deleted before delivery. */
  pageTitle: string
  pagePath: string
  pageLocale: string
  userId: string
  action: PageWatchNotifiableAction
  actorId: string | null
  /** Page field names the change touched; empty for a delete. */
  changedFields: string[]
  /** Captured like `pageTitle`/`pagePath`: the preference may change before delivery. */
  notifyMode: WatchNotifyMode
}

export interface RecordedWatchEvent {
  id: string
  userId: string
}

export interface PendingDigestEvent {
  id: string
  userId: string
  /** Null once the page has been deleted; `pageTitle`/`pagePath`/`pageLocale` are what survive. */
  pageId: string | null
  pageTitle: string
  pagePath: string
  pageLocale: string
  siteId: string
  action: PageWatchNotifiableAction
  changedFields: string[]
  actorId: string | null
}

export interface InboxNotification {
  id: string
  pageId: string | null
  pageTitle: string
  pagePath: string
  pageLocale: string
  action: PageWatchNotifiableAction
  changedFields: string[]
  actorId: string | null
  createdAt: Date
}

const INBOX_LIST_LIMIT = 50

/**
 * A hard ceiling on what one `sendWatchDigests` run loads into memory: a prolonged SMTP outage lets
 * the pending backlog grow unbounded. Delivered rows drop out of the next call's `WHERE`, so a
 * capped run still drains the backlog over successive nights rather than reprocessing the same rows.
 */
export const DIGEST_PENDING_LIMIT = 1000

export const UNREAD_COUNT_SCAN_LIMIT = 100

/**
 * The delivery queue behind page watching: one row per watcher per change, `deliveredAt` null until
 * something sends it. Written by the `notifyPageWatchers` job, except for a `deleted` event, where
 * `models/pages.ts#notifyWatchers` calls `recordMany()` synchronously before the page row goes —
 * `pageId`'s foreign key makes that ordering load-bearing.
 *
 * The same rows are the in-app inbox, through a `readAt` column independent of `deliveredAt`.
 */
class PageWatchEvents {
  /**
   * A single bulk insert, not one call per watcher: this is the part of notifying watchers that
   * scales with how many there are, which is why it runs in a queued job rather than inline in the
   * request that triggered it. Postgres does not guarantee `RETURNING` order for a multi-row
   * `INSERT ... VALUES`, so the caller matches rows by `userId` — unique within one batch, since a
   * watcher appears at most once per page.
   */
  async recordMany(events: PendingWatchEvent[]): Promise<RecordedWatchEvent[]> {
    if (events.length < 1) {
      return []
    }
    return CARDINAL.db
      .insert(pageWatchEventsTable)
      .values(events)
      .returning({ id: pageWatchEventsTable.id, userId: pageWatchEventsTable.userId })
  }

  /** So the digest job never re-sends what an immediate send already covered. */
  async markDelivered(id: string): Promise<void> {
    await CARDINAL.db
      .update(pageWatchEventsTable)
      .set({ deliveredAt: sql`now()` })
      .where(eq(pageWatchEventsTable.id, id))
  }

  /**
   * Ordered by (user, site, oldest first) so `tasks/simple/send-watch-digests.ts` can group straight
   * into one email per pair.
   *
   * `notifyMode` filters here rather than in the caller: an `immediate`-mode row can also be pending
   * (a failed send left it that way), and this job must never re-send it as part of a digest just
   * because it happens to still be undelivered.
   */
  async listPendingForDigest(): Promise<PendingDigestEvent[]> {
    return CARDINAL.db
      .select({
        id: pageWatchEventsTable.id,
        userId: pageWatchEventsTable.userId,
        pageId: pageWatchEventsTable.pageId,
        pageTitle: pageWatchEventsTable.pageTitle,
        pagePath: pageWatchEventsTable.pagePath,
        pageLocale: pageWatchEventsTable.pageLocale,
        siteId: pageWatchEventsTable.siteId,
        action: pageWatchEventsTable.action,
        changedFields: pageWatchEventsTable.changedFields,
        actorId: pageWatchEventsTable.actorId
      })
      .from(pageWatchEventsTable)
      .where(
        and(isNull(pageWatchEventsTable.deliveredAt), eq(pageWatchEventsTable.notifyMode, 'digest'))
      )
      .orderBy(
        asc(pageWatchEventsTable.userId),
        asc(pageWatchEventsTable.siteId),
        asc(pageWatchEventsTable.createdAt)
      )
      .limit(DIGEST_PENDING_LIMIT) as Promise<PendingDigestEvent[]>
  }

  /**
   * Deletes regardless of `deliveredAt`/`readAt`: a permanently-failed send, or a digest recipient
   * who never opens their inbox, must not accumulate rows forever because nothing marked them done.
   */
  async purgeExpired(): Promise<number> {
    const result = await CARDINAL.db
      .delete(pageWatchEventsTable)
      .where(lt(pageWatchEventsTable.createdAt, sql`now() - interval '90 days'`))
    return result.rowCount ?? 0
  }

  async markManyDelivered(ids: string[]): Promise<void> {
    if (ids.length < 1) {
      return
    }
    await CARDINAL.db
      .update(pageWatchEventsTable)
      .set({ deliveredAt: sql`now()` })
      .where(inArray(pageWatchEventsTable.id, ids))
  }

  /**
   * Capped at `INBOX_LIST_LIMIT` rather than paginated: an unbounded unread backlog is not a case
   * this handles gracefully, and the badge it feeds (`unreadCount`) is a separate, uncapped query.
   *
   * `read:pages` is re-checked at read time (`filterReadable`), not just when the event was
   * recorded; a row that fails is dropped from the list rather than surfaced as a refusal.
   */
  async listForUser(userId: string, siteId: string): Promise<InboxNotification[]> {
    const rows = await CARDINAL.db
      .select({
        id: pageWatchEventsTable.id,
        pageId: pageWatchEventsTable.pageId,
        pageTitle: pageWatchEventsTable.pageTitle,
        pagePath: pageWatchEventsTable.pagePath,
        pageLocale: pageWatchEventsTable.pageLocale,
        siteId: pageWatchEventsTable.siteId,
        action: pageWatchEventsTable.action,
        changedFields: pageWatchEventsTable.changedFields,
        actorId: pageWatchEventsTable.actorId,
        createdAt: pageWatchEventsTable.createdAt
      })
      .from(pageWatchEventsTable)
      .where(
        and(
          eq(pageWatchEventsTable.userId, userId),
          eq(pageWatchEventsTable.siteId, siteId),
          isNull(pageWatchEventsTable.readAt)
        )
      )
      .orderBy(desc(pageWatchEventsTable.createdAt))
      .limit(INBOX_LIST_LIMIT)
    return (await this.filterReadable(userId, rows)) as InboxNotification[]
  }

  /**
   * The `read:pages` re-check `listForUser` (read time) and `tasks/simple/send-watch-digests.ts`
   * (send time) share — hence public, not private: a user can lose access to a page between the
   * change happening and the notification being acted on. Checked against the LIVE page where one
   * still exists, since its rules may have changed either way since the event was recorded, and
   * falling back to the event's own `pagePath`/`pageLocale` snapshot — with no tags or
   * classification to narrow against — for a page that has since been deleted.
   */
  async filterReadable<
    T extends { pageId: string | null; pagePath: string; pageLocale: string; siteId: string }
  >(userId: string, events: T[]): Promise<T[]> {
    if (events.length < 1) {
      return []
    }
    const pageIds = [...new Set(events.map((event) => event.pageId).filter((id) => id !== null))]
    const liveRows = await CARDINAL.db
      .select({
        id: pagesTable.id,
        path: pagesTable.path,
        locale: pagesTable.locale,
        tags: pagesTable.tags,
        classification: pagesTable.classification
      })
      .from(pagesTable)
      .where(inArray(pagesTable.id, pageIds))
    const livePages = new Map(liveRows.map((row) => [row.id, row]))

    const actor = await CARDINAL.models.groups.actorForUserId(userId)
    return events.filter((event) => {
      const live = event.pageId === null ? undefined : livePages.get(event.pageId)
      return CARDINAL.models.groups.checkAccess(actor, 'read:pages', {
        path: live?.path ?? event.pagePath,
        siteId: event.siteId,
        locale: live?.locale ?? event.pageLocale,
        tags: live?.tags ?? [],
        classification: live?.classification ?? null
      })
    })
  }

  /**
   * Scoped to the caller so nobody marks another user's row read by guessing its id. Answers whether
   * the row exists and belongs to this user — the route's 404 vs 200.
   *
   * The `UPDATE ... WHERE readAt IS NULL` touches the row only on its first read, so the existence
   * query behind it is what makes a second call answer `true` rather than `false`.
   */
  async markRead(id: string, userId: string): Promise<boolean> {
    const updated = await CARDINAL.db
      .update(pageWatchEventsTable)
      .set({ readAt: sql`now()` })
      .where(
        and(
          eq(pageWatchEventsTable.id, id),
          eq(pageWatchEventsTable.userId, userId),
          isNull(pageWatchEventsTable.readAt)
        )
      )
      .returning({ id: pageWatchEventsTable.id })
    if (updated.length > 0) {
      return true
    }
    const existing = await CARDINAL.db
      .select({ id: pageWatchEventsTable.id })
      .from(pageWatchEventsTable)
      .where(and(eq(pageWatchEventsTable.id, id), eq(pageWatchEventsTable.userId, userId)))
      .limit(1)
    return existing.length > 0
  }

  /**
   * A separate `SELECT count(*)` rather than `listForUser(...).length`, so the badge stays accurate
   * past `INBOX_LIST_LIMIT` instead of capping out at the list's own page size.
   *
   * FIXME: no `filterReadable` pass here, so this counts rows `listForUser` drops — a user who has
   * lost `read:pages` on a page sees a badge its own list cannot account for.
   */
  async unreadCount(userId: string, siteId: string): Promise<number> {
    const rows = await CARDINAL.db
      .select({
        pageId: pageWatchEventsTable.pageId,
        pagePath: pageWatchEventsTable.pagePath,
        pageLocale: pageWatchEventsTable.pageLocale,
        siteId: pageWatchEventsTable.siteId
      })
      .from(pageWatchEventsTable)
      .where(
        and(
          eq(pageWatchEventsTable.userId, userId),
          eq(pageWatchEventsTable.siteId, siteId),
          isNull(pageWatchEventsTable.readAt)
        )
      )
      .orderBy(desc(pageWatchEventsTable.createdAt))
      .limit(UNREAD_COUNT_SCAN_LIMIT)
    return (await this.filterReadable(userId, rows)).length
  }
}

export const pageWatchEvents = new PageWatchEvents()
