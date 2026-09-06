import { and, asc, count, desc, eq, ne } from 'drizzle-orm'
import {
  pageWatching as watchingTable,
  pages as pagesTable,
  users as usersTable
} from '../db/schema.ts'
import type { PageWatchNotifiableAction } from './pageWatchEvents.ts'

/** `immediate` sends a mail per change; `digest` batches them for a later send. */
export type WatchNotifyMode = 'immediate' | 'digest'

/**
 * The delivery preference on one watch. Every field optional/nullable throughout: a caller (or a
 * stored row) that leaves one out means "no opinion, use the default" for that field specifically —
 * setting a `notifyMode` does not force the caller to also restate which change types matter.
 */
export interface WatchNotifyPreference {
  notifyMode?: WatchNotifyMode | null
  notifyOnEdited?: boolean | null
  notifyOnMoved?: boolean | null
  notifyOnDeleted?: boolean | null
}

/** The resolved preference, every field settled — what `resolvePreference` always returns. */
export interface ResolvedWatchNotifyPreference {
  notifyMode: WatchNotifyMode
  notifyOnEdited: boolean
  notifyOnMoved: boolean
  notifyOnDeleted: boolean
}

/**
 * What a watcher gets when they never touch their preference at all.
 *
 * `digest` rather than `immediate`: this is the one knob that is safe to get wrong in either
 * direction EXCEPT this one. An instance can go live, and watches can start accumulating, before
 * anybody has configured outbound mail (`WIKI.config.mail`) — see `models/mail.ts`. Defaulting to
 * `immediate` means the very first save on a watched page attempts a send against a transporter that
 * may not exist yet; defaulting to `digest` means it queues instead, harmlessly, until either mail
 * gets configured or the digest job (a later task) ships. Every change type notifies by default,
 * matching the behavior `models/pages.ts#notifyWatchers` already has today (see task 528): nothing
 * about adding a preference should silently narrow what an existing watcher gets told about.
 */
const DEFAULT_PREFERENCE: ResolvedWatchNotifyPreference = {
  notifyMode: 'digest',
  notifyOnEdited: true,
  notifyOnMoved: true,
  notifyOnDeleted: true
}

/** Fills in `DEFAULT_PREFERENCE` for whichever fields a stored row left null. */
export function resolvePreference(stored: WatchNotifyPreference): ResolvedWatchNotifyPreference {
  return {
    notifyMode: stored.notifyMode ?? DEFAULT_PREFERENCE.notifyMode,
    notifyOnEdited: stored.notifyOnEdited ?? DEFAULT_PREFERENCE.notifyOnEdited,
    notifyOnMoved: stored.notifyOnMoved ?? DEFAULT_PREFERENCE.notifyOnMoved,
    notifyOnDeleted: stored.notifyOnDeleted ?? DEFAULT_PREFERENCE.notifyOnDeleted
  }
}

/** Whether a resolved preference wants to hear about this kind of change at all. */
export function wantsAction(
  preference: ResolvedWatchNotifyPreference,
  action: PageWatchNotifiableAction
): boolean {
  if (action === 'updated') return preference.notifyOnEdited
  if (action === 'moved') return preference.notifyOnMoved
  return preference.notifyOnDeleted
}

/** A watched page, as the inbox lists it. */
export interface WatchedPage {
  pageId: string
  path: string
  locale: string
  title: string
  description: string | null
  icon: string | null
  /** When the page itself last changed, which is what a watcher is watching FOR. */
  updatedAt: Date
  /** When this person started watching, i.e. how long they have been asking to be told. */
  watchedAt: Date
  /** This watch's delivery preference, resolved with `DEFAULT_PREFERENCE` — never a raw null. */
  preference: ResolvedWatchNotifyPreference
}

/** One person watching a page, as the page metadata rail plates them. */
export interface PageWatcher {
  userId: string
  name: string
  /** Up to two letters for the plate — see `initialsFor`. */
  initials: string
  /** When this person started watching, which is what orders the list. */
  watchedAt: Date
}

/** `listForPage`'s answer: the leading watchers, and how many there are in total. */
export interface PageWatchers {
  watchers: PageWatcher[]
  /** Every watcher of the page, not just the ones returned — what the `+N` remainder counts from. */
  total: number
}

/**
 * Up to two letters, from the first and last word of a name — `Ada Lovelace` gives `AL`, and a
 * mononym gives its first letter. A nameless account gets a neutral glyph rather than a blank plate.
 *
 * The same derivation `frontend/src/components/CollabPresence.vue` draws its presence avatars with.
 * It is repeated here rather than left to the caller because `initials` is part of THIS route's
 * response contract (see `api/schemas/watcher.ts`), which any consumer reads — not only the SPA,
 * which has its own copy for the avatars it renders from data that never came from here.
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
 * Page watching model
 *
 * Who has asked to be told about which pages, and how: the bell on a page reads `isWatching`, the
 * inbox lists `listForUser`, the page metadata rail's Watching section reads `listForPage`, and
 * `models/pages.ts#notifyWatchers` reads `listWatchers` to resolve who gets a notification — and
 * whether it should be sent right away or left for the digest job — for one change.
 *
 * `listForPage` and `listWatchers` both answer "who watches this page" and are NOT variations of one
 * method: the first is a public, ordered, counted read for display, the second a notification-path
 * read that excludes the actor, honours each watcher's delivery preference and re-checks their own
 * `read:pages`. Each documents where its own line is drawn.
 */
class PageWatching {
  /**
   * Whether this user is watching this page.
   *
   * Answered for the page view, which asks about every page it draws, so it is a single indexed lookup
   * on the pair — and not asked at all for a guest, who cannot watch anything.
   */
  async isWatching(pageId: string, userId: string | null): Promise<boolean> {
    if (!userId) {
      return false
    }
    const rows = await WIKI.db
      .select({ id: watchingTable.id })
      .from(watchingTable)
      .where(and(eq(watchingTable.pageId, pageId), eq(watchingTable.userId, userId)))
      .limit(1)
    return rows.length > 0
  }

  /**
   * Start watching a page, optionally setting its delivery preference at the same time.
   *
   * Idempotent: watching a page one is already watching is what the reader asked for, and the unique
   * index turns the second row into nothing rather than into an error — which means a preference
   * passed here only ever takes effect on the FIRST watch. Changing the preference on a watch that
   * already exists goes through `setPreference()` instead; folding that into an upsert here would
   * make re-pressing the watch button (a no-op today) silently overwrite whatever the watcher had
   * chosen, the first time it happened to run with different defaults in the request.
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
    await WIKI.db
      .insert(watchingTable)
      .values({ siteId, pageId, userId, ...preference })
      .onConflictDoNothing({ target: [watchingTable.pageId, watchingTable.userId] })
  }

  /**
   * Change the delivery preference on an existing watch.
   *
   * Only the fields passed are touched — omitting `notifyMode` leaves it exactly as stored, it does
   * not reset it to null — so a caller adjusting one knob in a preferences panel never has to first
   * read the other three back just to echo them unchanged. Returns whether a watch existed to update:
   * there is nothing to set a preference ON if the caller is not watching the page, and the route
   * uses this to tell the two cases apart rather than silently succeeding at nothing.
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
    const rows = await WIKI.db
      .update(watchingTable)
      .set(preference)
      .where(and(eq(watchingTable.pageId, pageId), eq(watchingTable.userId, userId)))
      .returning({ id: watchingTable.id })
    return rows.length > 0
  }

  /**
   * The resolved delivery preference for one watch, or null if there is no such watch.
   *
   * Used to answer both `watch` and `setPreference` back to the caller with what is actually stored
   * now, rather than echoing back whatever the request happened to send — `watch()` silently ignores
   * a preference passed to an already-existing watch (see its own comment), so echoing the request
   * body there would show the caller a preference that was never applied.
   */
  async getPreference(
    pageId: string,
    userId: string
  ): Promise<ResolvedWatchNotifyPreference | null> {
    const rows = await WIKI.db
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

  /**
   * Stop watching a page. Also idempotent, for the same reason: the outcome asked for is that no row
   * exists, and it does not.
   */
  async unwatch({ pageId, userId }: { pageId: string; userId: string }): Promise<void> {
    await WIKI.db
      .delete(watchingTable)
      .where(and(eq(watchingTable.pageId, pageId), eq(watchingTable.userId, userId)))
  }

  /**
   * The pages this user watches on a site, most recently watched first.
   *
   * Joined to the pages rather than storing a copy of the title and the path, so a page that is
   * renamed or moved is listed where it is now — which is the point of watching it. A deleted page
   * takes its rows with it through the foreign key, so nothing here can point at one that is gone.
   *
   * OpenProject #2173: `read:pages` was checked once, at subscribe time, and never again. A watcher
   * whose group lost the page (a path DENY written after they subscribed, a CLASSIFICATION rule, a
   * group membership change) kept seeing the page's title, path and current location here
   * indefinitely — this now re-checks `read:pages` live, against the row's CURRENT
   * path/locale/tags/classification, every time the list is read, and simply drops a row that no
   * longer passes rather than surfacing a 403 for the one entry: watching is per-page, so one revoked
   * page must not fail the caller's whole list.
   */
  async listForUser(siteId: string, userId: string): Promise<WatchedPage[]> {
    const rows = await WIKI.db
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
    const actor = await WIKI.models.groups.actorForUserId(userId)
    return rows
      .filter((row) =>
        WIKI.models.groups.checkAccess(actor, 'read:pages', {
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
   * Who is watching this page right now and wants to hear about this kind of change, minus one
   * person — the actor whose own change this is, since nobody needs telling about their own edit.
   * Each result carries its own resolved `notifyMode`, which is what tells `notifyWatchers`'s caller
   * whether to attempt an immediate send or leave the row for the digest job to pick up later.
   *
   * Called synchronously from `models/pages.ts#notifyWatchers` rather than from the job it queues: a
   * delete removes the page in the same request, which cascades this table away with it, so the watch
   * list AND each watcher's preference have to be read before that happens rather than whenever the
   * queued job gets around to it — by then there would be no row left to read either from. A single
   * indexed lookup either way — this is the part of notifying watchers that does NOT scale with how
   * many of them there are; writing a row per watcher is what the job is for.
   *
   * A watcher whose preference excludes this action type entirely (`wantsAction` false) is left out of
   * the result, not merely marked — there is nothing to queue for them.
   *
   * OpenProject #2173: also filtered through `read:pages`, checked fresh for each watcher's CURRENT
   * group membership against the page's CURRENT (pre-delete, for a `deleted` action) path, locale,
   * tags and classification — a watcher whose group has since lost the page entirely must not be
   * queued a notification, mailed one, or have a `pageWatchEvents` row recorded for one at all. Joined
   * against `pagesTable` rather than requiring the caller to pass the page's own fields in: this
   * method already runs while the row still exists (see this class's `notifyWatchers`-facing doc
   * comment above), so the live row is right there to read.
   */
  async listWatchers(
    siteId: string,
    pageId: string,
    excludeUserId: string,
    action: PageWatchNotifiableAction
  ): Promise<{ userId: string; notifyMode: WatchNotifyMode }[]> {
    const rows = await WIKI.db
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
      const actor = await WIKI.models.groups.actorForUserId(watcher.userId)
      if (
        WIKI.models.groups.checkAccess(actor, 'read:pages', {
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
   * Who is watching this page, oldest watcher first, plus how many there are in total.
   *
   * The page metadata rail's Watching section: a row of initial plates and a `+N` remainder. The cap
   * on how many plates are drawn is the RAIL's decision, so it arrives as `limit` and is nowhere in
   * here — `total` is always counted over every watcher, not over the returned slice, or the
   * remainder would be wrong the moment the cap changed.
   *
   * Oldest first (`asc` on `createdAt`), not newest: the plates are meant to read as who has been
   * following the page, and a page whose watchers churn should not have its rail reshuffle. The
   * ordering is the whole reason `watchedAt` comes back on each row — a consumer can see the order is
   * real rather than take the array's word for it.
   *
   * **Deliberately NOT filtered by each watcher's own `read:pages`**, unlike `listForUser` and
   * `listWatchers`. Those two answer "what should this person be shown / be mailed", so a watcher who
   * has since lost the page has to drop out of their own answer (OpenProject #2173). This answers
   * "who watches this page", asked BY somebody else; the privacy boundary is the CALLER's `read:pages`
   * on the page, which `helpers/pageAccess.ts#requireReadablePage` has already enforced before the
   * route gets here. Re-checking every watcher would also turn a fixed two-query read into one group
   * -rule evaluation per watcher for a decoration on the page view.
   *
   * `pageId` alone is the key — no `siteId`. A page belongs to exactly one site and the route resolved
   * it within that site already, so a second predicate would assert something the caller has proven;
   * `listForUser` takes a `siteId` because an inbox genuinely spans sites and this does not.
   */
  async listForPage(pageId: string, { limit }: { limit: number }): Promise<PageWatchers> {
    const rows = await WIKI.db
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
    /*
      Counted separately rather than inferred from `rows.length`, which only equals the total while the
      page has fewer watchers than the cap -- exactly the case the `+N` remainder does not exist for.
    */
    const totals = await WIKI.db
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
