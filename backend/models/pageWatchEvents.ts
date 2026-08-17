import { eq, sql } from 'drizzle-orm'
import { pageWatchEvents as pageWatchEventsTable } from '../db/schema.ts'

/** The kinds of change a watcher can be notified about. Never `created` — see `notifyWatchers`. */
export type PageWatchNotifiableAction = 'updated' | 'moved' | 'deleted'

/** One notification owed to one watcher, as `notifyPageWatchers` writes it. */
export interface PendingWatchEvent {
  siteId: string
  pageId: string
  userId: string
  action: PageWatchNotifiableAction
  /** Who made the change, or null if the account is gone by the time this is written. */
  actorId: string | null
  /** Which fields the change touched — empty for a move (see `movePage`) or a delete. */
  changedFields: string[]
}

/** A just-recorded row, enough for the caller to deliver it right away without a second lookup. */
export interface RecordedWatchEvent {
  id: string
  userId: string
}

/**
 * Page watch events model
 *
 * The delivery queue behind page watching: one row per watcher per change, written by the
 * `notifyPageWatchers` job and left with `deliveredAt` null until something sends it. An immediate
 * send (`tasks/simple/notify-page-watchers.ts`) marks its own row delivered right after a successful
 * send; anything left pending is what the digest job (a later task) will eventually work through.
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
}

export const pageWatchEvents = new PageWatchEvents()
