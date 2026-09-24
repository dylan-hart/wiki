import { and, asc, count, desc, eq, ne } from 'drizzle-orm'
import {
  pageWatching as watchingTable,
  pages as pagesTable,
  users as usersTable
} from '../db/schema.ts'
import type { AccessActor } from './groups.ts'
import type { PageWatchNotifiableAction } from './pageWatchEvents.ts'

export type WatchNotifyMode = 'immediate' | 'digest'

/**
 * Every field optional and nullable: a caller (or a stored row) that leaves one out means "no
 * opinion, use the default" for that field specifically, so setting a `notifyMode` does not force
 * the caller to also restate which change types matter.
 */
export interface WatchNotifyPreference {
  notifyMode?: WatchNotifyMode | null
  notifyOnEdited?: boolean | null
  notifyOnMoved?: boolean | null
  notifyOnDeleted?: boolean | null
}

export interface ResolvedWatchNotifyPreference {
  notifyMode: WatchNotifyMode
  notifyOnEdited: boolean
  notifyOnMoved: boolean
  notifyOnDeleted: boolean
}

/**
 * `digest` rather than `immediate`: an instance can go live, and watches start accumulating, before
 * anybody has configured outbound mail, so `immediate` would make the first save on a watched page
 * attempt a send against a transporter that may not exist. A digest row queues harmlessly instead.
 * Every change type notifies by default — adding a preference must not silently narrow what an
 * existing watcher is told about.
 */
const DEFAULT_PREFERENCE: ResolvedWatchNotifyPreference = {
  notifyMode: 'digest',
  notifyOnEdited: true,
  notifyOnMoved: true,
  notifyOnDeleted: true
}

export function resolvePreference(stored: WatchNotifyPreference): ResolvedWatchNotifyPreference {
  return {
    notifyMode: stored.notifyMode ?? DEFAULT_PREFERENCE.notifyMode,
    notifyOnEdited: stored.notifyOnEdited ?? DEFAULT_PREFERENCE.notifyOnEdited,
    notifyOnMoved: stored.notifyOnMoved ?? DEFAULT_PREFERENCE.notifyOnMoved,
    notifyOnDeleted: stored.notifyOnDeleted ?? DEFAULT_PREFERENCE.notifyOnDeleted
  }
}

export function wantsAction(
  preference: ResolvedWatchNotifyPreference,
  action: PageWatchNotifiableAction
): boolean {
  if (action === 'updated') return preference.notifyOnEdited
  if (action === 'moved') return preference.notifyOnMoved
  return preference.notifyOnDeleted
}

export interface WatchedPage {
  pageId: string
  path: string
  locale: string
  title: string
  description: string | null
  icon: string | null
  updatedAt: Date
  /** When this person started watching. */
  watchedAt: Date
  preference: ResolvedWatchNotifyPreference
}

export interface PageWatcher {
  userId: string
  name: string
  initials: string
  watchedAt: Date
}

export interface PageWatchers {
  watchers: PageWatcher[]
  /** Every watcher of the page, not just the returned slice — what a `+N` remainder counts from. */
  total: number
}

/**
 * Part of this route's response contract (`api/schemas/watcher.ts`), which any consumer reads, so it
 * is derived here rather than left to the caller — the SPA's own copy in `CollabPresence.vue` draws
 * presence avatars from data that never came from here.
 */
export function initialsFor(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length < 1) {
    return '?'
  }
  const last = words.length > 1 ? words.at(-1)![0] : ''
  return `${words[0]![0]}${last}`.toUpperCase()
}

/**
 * `listForPage` and `listWatchers` both answer "who watches this page" and are NOT variations of one
 * method: the first is a public, ordered, counted read for display, the second a notification-path
 * read that excludes the actor, honours each watcher's delivery preference and re-checks their own
 * `read:pages`.
 */
class PageWatching {
  async isWatching(pageId: string, userId: string | null): Promise<boolean> {
    if (!userId) {
      return false
    }
    const rows = await CARDINAL.db
      .select({ id: watchingTable.id })
      .from(watchingTable)
      .where(and(eq(watchingTable.pageId, pageId), eq(watchingTable.userId, userId)))
      .limit(1)
    return rows.length > 0
  }

  /**
   * Idempotent: the unique index turns a second watch into nothing rather than an error, so a
   * preference passed here only ever takes effect on the FIRST watch — changing one afterwards goes
   * through `setPreference()`. Folding that into an upsert would let re-pressing the watch button
   * silently overwrite whatever the watcher had chosen.
   */
  async watch({
    siteId,
    pageId,
    userId,
    ...preference
  }: {
    siteId: string
    pageId: string
    userId: string
  } & WatchNotifyPreference): Promise<void> {
    await CARDINAL.db
      .insert(watchingTable)
      .values({ siteId, pageId, userId, ...preference })
      .onConflictDoNothing({ target: [watchingTable.pageId, watchingTable.userId] })
  }

  /**
   * Only the fields passed are touched — omitting `notifyMode` leaves it exactly as stored rather
   * than resetting it to null — so a caller adjusting one knob never has to read the other three
   * back just to echo them. Answers whether a watch existed to update, which is how the route tells
   * "not watching this page" apart from silently succeeding at nothing.
   */
  async setPreference({
    pageId,
    userId,
    ...preference
  }: {
    pageId: string
    userId: string
  } & WatchNotifyPreference): Promise<boolean> {
    if (Object.keys(preference).length < 1) {
      return this.isWatching(pageId, userId)
    }
    const rows = await CARDINAL.db
      .update(watchingTable)
      .set(preference)
      .where(and(eq(watchingTable.pageId, pageId), eq(watchingTable.userId, userId)))
      .returning({ id: watchingTable.id })
    return rows.length > 0
  }

  /**
   * What lets `watch` and `setPreference` answer with what is actually stored rather than echoing
   * the request body: `watch()` silently ignores a preference passed to an already-existing watch,
   * so an echo would show the caller a preference that was never applied.
   */
  async getPreference(
    pageId: string,
    userId: string
  ): Promise<ResolvedWatchNotifyPreference | null> {
    const rows = await CARDINAL.db
      .select({
        notifyMode: watchingTable.notifyMode,
        notifyOnEdited: watchingTable.notifyOnEdited,
        notifyOnMoved: watchingTable.notifyOnMoved,
        notifyOnDeleted: watchingTable.notifyOnDeleted
      })
      .from(watchingTable)
      .where(and(eq(watchingTable.pageId, pageId), eq(watchingTable.userId, userId)))
      .limit(1)
    const [row] = rows
    if (!row) {
      return null
    }
    return resolvePreference({ ...row, notifyMode: row.notifyMode as WatchNotifyMode | null })
  }

  async unwatch({ pageId, userId }: { pageId: string; userId: string }): Promise<void> {
    await CARDINAL.db
      .delete(watchingTable)
      .where(and(eq(watchingTable.pageId, pageId), eq(watchingTable.userId, userId)))
  }

  /**
   * Joined to the pages rather than storing a copy of the title and the path, so a page that is
   * renamed or moved is listed where it is now — which is the point of watching it. A deleted page
   * takes its rows with it through the foreign key, so nothing here can point at one that is gone.
   *
   * `read:pages` is re-checked on every read, against each row's CURRENT
   * path/locale/tags/classification, not just at subscribe time. A row that no longer passes is
   * dropped rather than surfaced as a 403: watching is per-page, so one revoked page must not fail
   * the caller's whole list.
   *
   * @param actor Who is asking, as the request presents itself (`groups.actorForRequest`, or
   *   `mcp/auth.ts#actorFor`), not `userId`'s own full membership: an API key acting for the user
   *   carries its scope, classification allow-set and site pin, and a page any of them shuts out
   *   must not be listed through the key.
   */
  async listForUser(siteId: string, userId: string, actor: AccessActor): Promise<WatchedPage[]> {
    const rows = await CARDINAL.db
      .select({
        pageId: pagesTable.id,
        path: pagesTable.path,
        locale: pagesTable.locale,
        tags: pagesTable.tags,
        classification: pagesTable.classification,
        title: pagesTable.title,
        description: pagesTable.description,
        icon: pagesTable.icon,
        updatedAt: pagesTable.updatedAt,
        watchedAt: watchingTable.createdAt,
        notifyMode: watchingTable.notifyMode,
        notifyOnEdited: watchingTable.notifyOnEdited,
        notifyOnMoved: watchingTable.notifyOnMoved,
        notifyOnDeleted: watchingTable.notifyOnDeleted
      })
      .from(watchingTable)
      .innerJoin(pagesTable, eq(pagesTable.id, watchingTable.pageId))
      .where(and(eq(watchingTable.userId, userId), eq(watchingTable.siteId, siteId)))
      .orderBy(desc(watchingTable.createdAt))
    if (rows.length < 1) {
      return []
    }
    return rows
      .filter((row) =>
        CARDINAL.models.groups.checkAccess(actor, 'read:pages', {
          path: row.path,
          siteId,
          locale: row.locale,
          tags: row.tags ?? [],
          classification: row.classification ?? null
        })
      )
      .map(
        ({
          notifyMode,
          notifyOnEdited,
          notifyOnMoved,
          notifyOnDeleted,
          tags: _tags,
          classification: _classification,
          ...page
        }) => ({
          ...page,
          preference: resolvePreference({
            notifyMode: notifyMode as WatchNotifyMode | null,
            notifyOnEdited,
            notifyOnMoved,
            notifyOnDeleted
          })
        })
      ) as WatchedPage[]
  }

  /**
   * Called synchronously from `models/pages.ts#notifyWatchers` rather than from the job it queues: a
   * delete removes the page in the same request, which cascades this table away with it, so the
   * watch list AND each watcher's preference have to be read before that happens. The live page row
   * is joined in for the same reason — it is still there to check `read:pages` against.
   *
   * A watcher whose preference excludes this action, or whose groups have since lost the page, is
   * left out of the result rather than marked: there is nothing to queue for them.
   */
  async listWatchers(
    siteId: string,
    pageId: string,
    excludeUserId: string,
    action: PageWatchNotifiableAction
  ): Promise<{ userId: string; notifyMode: WatchNotifyMode }[]> {
    const rows = await CARDINAL.db
      .select({
        userId: watchingTable.userId,
        notifyMode: watchingTable.notifyMode,
        notifyOnEdited: watchingTable.notifyOnEdited,
        notifyOnMoved: watchingTable.notifyOnMoved,
        notifyOnDeleted: watchingTable.notifyOnDeleted,
        path: pagesTable.path,
        locale: pagesTable.locale,
        tags: pagesTable.tags,
        classification: pagesTable.classification
      })
      .from(watchingTable)
      .innerJoin(pagesTable, eq(pagesTable.id, watchingTable.pageId))
      .where(and(eq(watchingTable.pageId, pageId), ne(watchingTable.userId, excludeUserId)))
    const preferred = rows
      .map((row) => ({
        userId: row.userId,
        path: row.path,
        locale: row.locale,
        tags: row.tags ?? [],
        classification: row.classification ?? null,
        preference: resolvePreference({
          ...row,
          notifyMode: row.notifyMode as WatchNotifyMode | null
        })
      }))
      .filter(({ preference }) => wantsAction(preference, action))
    if (preferred.length < 1) {
      return []
    }
    const readable: { userId: string; notifyMode: WatchNotifyMode }[] = []
    for (const watcher of preferred) {
      const actor = await CARDINAL.models.groups.actorForUserId(watcher.userId)
      if (
        CARDINAL.models.groups.checkAccess(actor, 'read:pages', {
          path: watcher.path,
          siteId,
          locale: watcher.locale,
          tags: watcher.tags,
          classification: watcher.classification
        })
      ) {
        readable.push({ userId: watcher.userId, notifyMode: watcher.preference.notifyMode })
      }
    }
    return readable
  }

  /**
   * How many plates the rail draws is the RAIL's decision, so it arrives as `limit`; `total` is
   * counted over every watcher, not the returned slice, or the `+N` remainder would be wrong the
   * moment the cap changed. Oldest first, so a page whose watchers churn does not reshuffle its rail.
   *
   * **Deliberately NOT filtered by each watcher's own `read:pages`**, unlike `listForUser` and
   * `listWatchers`: this answers "who watches this page", asked BY somebody else, whose own
   * `read:pages` `helpers/pageAccess.ts#requireReadablePage` has already enforced. Re-checking every
   * watcher would also turn a fixed two-query read into one group-rule evaluation per watcher.
   *
   * `pageId` alone is the key: a page belongs to one site, which the route already resolved.
   */
  async listForPage(pageId: string, { limit }: { limit: number }): Promise<PageWatchers> {
    const rows = await CARDINAL.db
      .select({
        userId: watchingTable.userId,
        name: usersTable.name,
        watchedAt: watchingTable.createdAt
      })
      .from(watchingTable)
      .innerJoin(usersTable, eq(usersTable.id, watchingTable.userId))
      .where(eq(watchingTable.pageId, pageId))
      .orderBy(asc(watchingTable.createdAt), asc(watchingTable.userId))
      .limit(limit)
    const totals = await CARDINAL.db
      .select({ total: count() })
      .from(watchingTable)
      .where(eq(watchingTable.pageId, pageId))
    return {
      watchers: rows.map((row) => ({
        userId: row.userId,
        name: row.name,
        initials: initialsFor(row.name),
        watchedAt: row.watchedAt
      })),
      total: totals[0]?.total ?? 0
    }
  }
}

export const pageWatching = new PageWatching()
