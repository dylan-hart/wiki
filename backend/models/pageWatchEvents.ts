import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { pageWatchEvents as pageWatchEventsTable } from '../db/schema.ts'
import type { WatchNotifyMode } from './pageWatching.ts'

/** The kinds of change a watcher can be notified about. Never `created` — see `notifyWatchers`. */
export type PageWatchNotifiableAction = 'updated' | 'moved' | 'deleted'

/** One notification owed to one watcher, as `notifyPageWatchers` writes it. */
export interface PendingWatchEvent {
  siteId: string
  pageId: string
  /** The page's title/path as of this change — see `db/schema.ts#pageWatchEvents`'s own comment. */
  pageTitle: string
  pagePath: string
  userId: string
  action: PageWatchNotifiableAction
  /** Who made the change, or null if the account is gone by the time this is written. */
  actorId: string | null
  /** Which fields the change touched — empty for a move (see `movePage`) or a delete. */
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
  action: PageWatchNotifiableAction
  changedFields: string[]
  actorId: string | null
}

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
}

export const pageWatchEvents = new PageWatchEvents()
