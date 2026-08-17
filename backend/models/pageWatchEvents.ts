import { pageWatchEvents as pageWatchEventsTable } from '../db/schema.ts'

/** The kinds of change a watcher can be notified about. Never `created` — see `notifyWatchers`. */
export type PageWatchNotifiableAction = 'updated' | 'moved' | 'deleted'

/** One notification owed to one watcher, as `notifyPageWatchers` writes it. */
export interface PendingWatchEvent {
  siteId: string
  pageId: string
  userId: string
  action: PageWatchNotifiableAction
}

/**
 * Page watch events model
 *
 * The delivery queue behind page watching: one row per watcher per change, written by the
 * `notifyPageWatchers` job and left with `deliveredAt` null until something sends it. Nothing reads
 * or delivers these yet — that is the next task's job — so this is the write side and nothing more.
 */
class PageWatchEvents {
  /**
   * Record a pending notification for each watcher of a change.
   *
   * A single bulk insert, not one call per watcher: this is the part of notifying watchers that scales
   * with how many there are, which is exactly why `notifyPageWatchers` runs it in a queued job rather
   * than inline in the save/move/delete request that triggered it.
   */
  async recordMany(events: PendingWatchEvent[]): Promise<void> {
    if (events.length < 1) {
      return
    }
    await WIKI.db.insert(pageWatchEventsTable).values(events)
  }
}

export const pageWatchEvents = new PageWatchEvents()
