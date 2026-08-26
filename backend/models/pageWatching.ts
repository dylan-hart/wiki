import { and, desc, eq, ne } from 'drizzle-orm'
import { pageWatching as watchingTable, pages as pagesTable } from '../db/schema.ts'
import type { PageWatchNotifiableAction } from './pageWatchEvents.ts'
import type { RulePageRef } from '../helpers/pageRules.ts'

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

/**
 * Page watching model
 *
 * Who has asked to be told about which pages, and how: the bell on a page reads `isWatching`, the
 * inbox lists `listForUser`, and `models/pages.ts#notifyWatchers` reads `listWatchers` to resolve who
 * gets a notification — and whether it should be sent right away or left for the digest job — for one
 * change.
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
   * `read:pages` is re-checked here against the LIVE page (OpenProject #2173), not merely assumed from
   * having been grantable at watch time: a row this join still finds is a page that still exists, but
   * a classification raised, a move into a restricted branch, or a group rule edited since can have
   * taken the caller's own ability to read it away in the meantime, and this is what the watch-list
   * route (`GET /sites/:siteId/watching`) answers with — it must not go on describing a page the
   * caller can no longer see, title/path/description included.
   */
  async listForUser(siteId: string, userId: string): Promise<WatchedPage[]> {
    const rows = await WIKI.db
      .select({
        pageId: pagesTable.id,
        path: pagesTable.path,
        locale: pagesTable.locale,
        title: pagesTable.title,
        description: pagesTable.description,
        icon: pagesTable.icon,
        updatedAt: pagesTable.updatedAt,
        tags: pagesTable.tags,
        classification: pagesTable.classification,
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
    const actor = await WIKI.models.groups.actorForUser(userId)
    return rows
      .filter((row) =>
        WIKI.models.groups.checkAccess(actor, 'read:pages', {
          path: row.path,
          locale: row.locale,
          siteId,
          classification: row.classification,
          tags: row.tags ?? []
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
   * `page` is the ref this change leaves the page at (its post-change path/locale/classification/tags
   * — see each call site in `models/pages.ts#notifyWatchers`), and every remaining watcher is
   * re-checked against it for `read:pages` before being returned (OpenProject #2173): a watch was only
   * ever gated on being able to read the page at SUBSCRIBE time, so without this a watcher whose
   * access has since been revoked — a raised classification, a move into a restricted branch, an
   * edited group rule — would still be told the page's new title, path and a working link. Checked per
   * watcher, since each one's own current groups decide their own answer.
   */
  async listWatchers(
    pageId: string,
    excludeUserId: string,
    action: PageWatchNotifiableAction,
    page: RulePageRef
  ): Promise<{ userId: string; notifyMode: WatchNotifyMode }[]> {
    const rows = await WIKI.db
      .select({
        userId: watchingTable.userId,
        notifyMode: watchingTable.notifyMode,
        notifyOnEdited: watchingTable.notifyOnEdited,
        notifyOnMoved: watchingTable.notifyOnMoved,
        notifyOnDeleted: watchingTable.notifyOnDeleted
      })
      .from(watchingTable)
      .where(and(eq(watchingTable.pageId, pageId), ne(watchingTable.userId, excludeUserId)))
    const wanting = rows
      .map((row) => ({
        userId: row.userId,
        preference: resolvePreference({
          ...row,
          notifyMode: row.notifyMode as WatchNotifyMode | null
        })
      }))
      .filter(({ preference }) => wantsAction(preference, action))
    const readable = await Promise.all(
      wanting.map(async ({ userId }) => {
        const actor = await WIKI.models.groups.actorForUser(userId)
        return WIKI.models.groups.checkAccess(actor, 'read:pages', page)
      })
    )
    return wanting
      .filter((_, index) => readable[index])
      .map(({ userId, preference }) => ({ userId, notifyMode: preference.notifyMode }))
  }
}

export const pageWatching = new PageWatching()
