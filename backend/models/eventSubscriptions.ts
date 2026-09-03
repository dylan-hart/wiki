import { and, eq } from 'drizzle-orm'
import { eventSubscriptions as subsTable } from '../db/schema.ts'
import type { HookEvent } from './hooks.ts'

/**
 * Event subscriptions model
 *
 * Who has opted in to an email whenever a given event fires — see `db/schema.ts#eventSubscriptions`
 * for why a row IS the subscription (no `enabled` column). `models/hooks.ts#emit()` reads
 * `listSubscribers` to resolve who gets queued a notification for one event, the same role
 * `models/pageWatching.ts#listWatchers` plays for a page change.
 */
class EventSubscriptions {
  /** Whether this user is subscribed to this event. */
  async isSubscribed(userId: string, event: HookEvent | string): Promise<boolean> {
    const rows = await WIKI.db
      .select({ id: subsTable.id })
      .from(subsTable)
      .where(and(eq(subsTable.userId, userId), eq(subsTable.event, event)))
      .limit(1)
    return rows.length > 0
  }

  /**
   * Subscribe to an event. Idempotent: subscribing twice is subscribing once, so the unique index
   * turns a second attempt into a no-op rather than an error.
   */
  async subscribe(userId: string, event: HookEvent | string): Promise<void> {
    await WIKI.db
      .insert(subsTable)
      .values({ userId, event })
      .onConflictDoNothing({ target: [subsTable.userId, subsTable.event] })
  }

  /** Unsubscribe from an event. Also idempotent: the outcome asked for is that no row exists. */
  async unsubscribe(userId: string, event: HookEvent | string): Promise<void> {
    await WIKI.db
      .delete(subsTable)
      .where(and(eq(subsTable.userId, userId), eq(subsTable.event, event)))
  }

  /**
   * Every user subscribed to this event, as plain user ids.
   *
   * Returns ids rather than an enriched (email, locale) shape — `tasks/simple/notify-event-
   * subscribers.ts` already resolves each recipient via `WIKI.models.users.getById`, the same way
   * `tasks/simple/notify-page-watchers.ts` does for each page watcher, so a per-user email/locale
   * lookup lives in exactly one place.
   */
  async listSubscribers(event: HookEvent | string): Promise<string[]> {
    const rows = await WIKI.db
      .select({ userId: subsTable.userId })
      .from(subsTable)
      .where(eq(subsTable.event, event))
    return rows.map((row) => row.userId)
  }
}

export const eventSubscriptions = new EventSubscriptions()
