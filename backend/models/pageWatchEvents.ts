import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { pageWatchEvents as pageWatchEventsTable } from '../db/schema.ts'
import type { WatchNotifyMode } from './pageWatching.ts'

/** The kinds of change a watcher can be notified about. Never `created` — see `notifyWatchers`. */
export type PageWatchNotifiableAction = 'updated' | 'moved' | 'deleted'

/** One notification owed to one watcher, as `notifyPageWatchers` writes it. */
export interface PendingWatchEvent {
  siteId: string
  pageId: string
  /** The page's title/path/locale as of this change — see `db/schema.ts#pageWatchEvents`'s own comment. */
  pageTitle: string
  pagePath: string
  pageLocale: string
  userId: string
  action: PageWatchNotifiableAction
  /** Who made the change, or null if the account is gone by the time this is written. */
  actorId: string | null
  /** Which fields the change touched — up to `['path', 'locale', 'title']` for a move (see
   *  `movePage`), empty for a delete. */
  changedFields: string[]
  /** This watcher's resolved delivery mode, captured for the same reason `pageTitle`/`pagePath` are. */
  notifyMode: WatchNotifyMode
}

/** A just-recorded row, enough for the caller to deliver it right away without a second lookup. */
export interface RecordedWatchEvent {
  id: string
  userId: string
}

/** One user's still-undelivered digest-mode notification, as the digest job reads it. */
export interface PendingDigestEvent {
  id: string
  userId: string
  pageId: string
  pageTitle: string
  pagePath: string
  pageLocale: string
  siteId: string
  action: PageWatchNotifiableAction
  changedFields: string[]
  actorId: string | null
}

/** One unread notification, as the in-app inbox (task 535) lists it. */
export interface InboxNotification {
  id: string
  pageId: string
  pageTitle: string
  pagePath: string
  pageLocale: string
  action: PageWatchNotifiableAction
  changedFields: string[]
  actorId: string | null
  createdAt: Date
}

/** How many unread rows the in-app inbox lists before it stops — plenty for a badge/list, not a feed. */
const INBOX_LIST_LIMIT = 50

/**
 * Page watch events model
 *
 * The delivery queue behind page watching: one row per watcher per change, written by the
 * `notifyPageWatchers` job and left with `deliveredAt` null until something sends it. An immediate
 * send (`tasks/simple/notify-page-watchers.ts`) marks its own row delivered right after a successful
 * send; anything left pending with `notifyMode: 'digest'` is what `tasks/simple/send-watch-digests.ts`
 * eventually works through. (A pending `immediate` row also exists — a failed send is left pending
 * rather than thrown, see that task's own doc comment — but it is not this model's job to tell the
 * two apart at read time beyond what `listPendingForDigest` already filters on.)
 *
 * It is also, since task 535, the in-app notification inbox: `listForUser`/`markRead`/`unreadCount`
 * read and write the separate `readAt` column (see `db/schema.ts#pageWatchEvents`'s own comment on why
 * it is not `deliveredAt`), independent of whatever mail delivery has or hasn't done with a row.
 */
class PageWatchEvents {
  /**
   * Record a pending notification for each watcher of a change, returning enough of each inserted row
   * (`id`, `userId`) for an immediate-mode send to mark its own row delivered afterwards.
   *
   * A single bulk insert, not one call per watcher: this is the part of notifying watchers that scales
   * with how many there are, which is exactly why `notifyPageWatchers` runs it in a queued job rather
   * than inline in the save/move/delete request that triggered it. The `RETURNING` is read back keyed
   * by `userId` rather than assumed to preserve the input array's order — Postgres does not guarantee
   * that for a multi-row `INSERT ... VALUES`, and `userId` is unique within one call's batch (each
   * watcher appears at most once per page), so it is what the caller matches on.
   */
  async recordMany(events: PendingWatchEvent[]): Promise<RecordedWatchEvent[]> {
    if (events.length < 1) {
      return []
    }
    return WIKI.db
      .insert(pageWatchEventsTable)
      .values(events)
      .returning({ id: pageWatchEventsTable.id, userId: pageWatchEventsTable.userId })
  }

  /**
   * Mark one pending notification delivered, so the digest job never re-sends what an immediate send
   * already covered.
   */
  async markDelivered(id: string): Promise<void> {
    await WIKI.db
      .update(pageWatchEventsTable)
      .set({ deliveredAt: sql`now()` })
      .where(eq(pageWatchEventsTable.id, id))
  }

  /**
   * Every still-undelivered `digest`-mode notification, across every user, oldest first within each
   * user — what `tasks/simple/send-watch-digests.ts` groups per user and turns into one email each.
   *
   * `notifyMode` filters here rather than the caller filtering after the fact: an `immediate`-mode
   * row can also be pending (a failed send left it that way — see `notify-page-watchers.ts`), and
   * that row belongs to a future in-app inbox, not to this job, which must never re-send it as part
   * of a digest just because it happens to still be undelivered.
   */
  async listPendingForDigest(): Promise<PendingDigestEvent[]> {
    return WIKI.db
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
      .orderBy(asc(pageWatchEventsTable.userId), asc(pageWatchEventsTable.createdAt)) as Promise<
      PendingDigestEvent[]
    >
  }

  /**
   * Mark every one of these pending notifications delivered in one statement, once a digest email
   * covering all of them has actually sent — the bulk counterpart to `markDelivered`, for the same
   * reason `recordMany` is bulk rather than one `INSERT` per watcher.
   */
  async markManyDelivered(ids: string[]): Promise<void> {
    if (ids.length < 1) {
      return
    }
    await WIKI.db
      .update(pageWatchEventsTable)
      .set({ deliveredAt: sql`now()` })
      .where(inArray(pageWatchEventsTable.id, ids))
  }

  /**
   * This user's unread notifications on this site, newest first — what the in-app inbox lists.
   *
   * Scoped to `siteId` for the same reason `pageWatching_user_site_idx` is: the inbox belongs to a
   * site. Capped at `INBOX_LIST_LIMIT` rather than paginated — a genuinely unbounded backlog of unread
   * notifications is not a case this first cut needs to handle gracefully, and the badge this feeds
   * (`unreadCount`) is a separate, un-capped query anyway.
   */
  async listForUser(userId: string, siteId: string): Promise<InboxNotification[]> {
    return WIKI.db
      .select({
        id: pageWatchEventsTable.id,
        pageId: pageWatchEventsTable.pageId,
        pageTitle: pageWatchEventsTable.pageTitle,
        pagePath: pageWatchEventsTable.pagePath,
        pageLocale: pageWatchEventsTable.pageLocale,
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
      .limit(INBOX_LIST_LIMIT) as Promise<InboxNotification[]>
  }

  /**
   * Mark one notification read, scoped to the caller so nobody can mark another user's row read by
   * guessing its id. Returns whether the row exists and belongs to this user — the route's 404 vs 200.
   *
   * Idempotent like `watch`/`unwatch` elsewhere in this feature: marking an already-read row read again
   * still answers `true`, because the outcome asked for (this notification is read) already holds. The
   * `UPDATE ... WHERE readAt IS NULL` only touches the row on its first read, but the existence check
   * that follows a no-op update is what makes a SECOND call also answer `true` instead of `false`.
   */
  async markRead(id: string, userId: string): Promise<boolean> {
    const updated = await WIKI.db
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
    const existing = await WIKI.db
      .select({ id: pageWatchEventsTable.id })
      .from(pageWatchEventsTable)
      .where(and(eq(pageWatchEventsTable.id, id), eq(pageWatchEventsTable.userId, userId)))
      .limit(1)
    return existing.length > 0
  }

  /**
   * How many unread notifications this user has on this site — the header badge's own query. A
   * separate `SELECT count(*)` rather than `listForUser(...).length`, so the badge stays accurate past
   * `INBOX_LIST_LIMIT` instead of capping out at the list's own page size.
   */
  async unreadCount(userId: string, siteId: string): Promise<number> {
    return WIKI.db.$count(
      pageWatchEventsTable,
      and(
        eq(pageWatchEventsTable.userId, userId),
        eq(pageWatchEventsTable.siteId, siteId),
        isNull(pageWatchEventsTable.readAt)
      )
    )
  }
}

export const pageWatchEvents = new PageWatchEvents()
