import type { PageWatchNotifiableAction } from '../../models/pageWatchEvents.ts'
import type { WatchNotifyMode } from '../../models/pageWatching.ts'

/** One watcher this event is queued for, with the delivery mode their preference resolved to. */
export interface QueuedWatcher {
  userId: string
  notifyMode: WatchNotifyMode
}

/** What `models/pages.ts#notifyWatchers` queues after resolving a page change's watcher list. */
export interface NotifyPageWatchersPayload {
  siteId: string
  pageId: string
  pageTitle: string
  pagePath: string
  pageLocale: string
  action: PageWatchNotifiableAction
  /** Up to `['path', 'locale', 'title']` for a move (see `models/pages.ts#movePage`), empty for a
   *  delete. */
  changedFields: string[]
  actorId: string
  watchers: QueuedWatcher[]
}

/**
 * Record a pending notification for each watcher of a page change, then attempt an immediate send for
 * whichever watchers asked for one.
 *
 * The watcher list itself — already paired with each watcher's resolved `notifyMode` — was resolved
 * before this was queued (see `notifyWatchers`); a page cascade-deletes its watch rows, so re-resolving
 * either the watcher list or `page`/`changedFields` here would find nothing left for a `deleted` event.
 * What is left for this job is the part that scales with how many people watch the page: one
 * `pageWatchEvents` row per watcher, and — for the `immediate` ones — the mail itself.
 *
 * A `digest`-mode watcher's row is left exactly as recorded, `deliveredAt` still null: the digest job
 * (a later task) is what eventually sends it. An `immediate`-mode watcher's row is marked delivered
 * right after a successful send, so the digest job never re-sends what already went out.
 *
 * A failed send is logged loudly and left pending rather than thrown: the row survives either way (see
 * `recordMany` above), which is what keeps a watcher's notification from being silently lost, and it is
 * also what a future in-app inbox (a separate task) will read regardless of whether mail ever succeeds
 * — so a misconfigured or momentarily-down SMTP server must not turn into a failed job here. A failed
 * job would retry the whole payload, including the `recordMany` call already covered by the `try` below
 * — re-running that on a mail-only failure would insert duplicate pending rows for every watcher, not
 * just the one whose send failed.
 *
 * OpenProject #2173: `read:pages` is re-checked once more here, right before the immediate-send loop
 * — a scheduler backlog can put real time between `notifyWatchers`'s own synchronous check (at page-
 * change time) and this job actually running. Checked with `WIKI.models.pageWatchEvents.filterReadable`
 * (shared with the in-app inbox's read-time re-check and the digest job's own send-time one) against
 * the live page where one still exists, falling back to this payload's own `pagePath`/`pageLocale` for
 * a `deleted` action, whose page row is already gone by the time this runs. Only gates the immediate
 * send: a `digest`-mode watcher's row is left exactly as recorded either way, since the digest job
 * re-checks it again itself at its own, later send time.
 */
export async function task(payload?: NotifyPageWatchersPayload): Promise<void> {
  if (!payload || payload.watchers.length < 1) {
    return
  }
  const {
    siteId,
    pageId,
    pageTitle,
    pagePath,
    pageLocale,
    action,
    changedFields,
    actorId,
    watchers
  } = payload

  let recorded: { id: string; userId: string }[]
  try {
    recorded = await WIKI.models.pageWatchEvents.recordMany(
      watchers.map((watcher) => ({
        siteId,
        pageId,
        pageTitle,
        pagePath,
        pageLocale,
        userId: watcher.userId,
        action,
        actorId,
        changedFields,
        notifyMode: watcher.notifyMode
      }))
    )
  } catch (err: any) {
    WIKI.logger.error('hooks', 'failed to record page watch notifications', {
      page: pageId,
      error: err
    })
    throw err
  }

  const immediateWatchers = watchers.filter((watcher) => watcher.notifyMode === 'immediate')
  if (immediateWatchers.length < 1) {
    return
  }

  const eventIdByUserId = new Map(recorded.map((row) => [row.userId, row.id]))
  const actorUser = await WIKI.models.users.getById(actorId)
  const actorName = actorUser?.name ?? 'Someone'

  for (const watcher of immediateWatchers) {
    const eventId = eventIdByUserId.get(watcher.userId)
    if (!eventId) {
      continue
    }
    // -> OpenProject #2173: re-checked once more, right before the send -- see this file's own doc
    //    comment above. A single-item batch: `filterReadable` is keyed to one user's events, and each
    //    watcher here is a different user.
    const readable = await WIKI.models.pageWatchEvents.filterReadable(watcher.userId, [
      { pageId, pagePath, pageLocale, siteId }
    ])
    if (readable.length < 1) {
      continue
    }
    try {
      const recipient = await WIKI.models.users.getById(watcher.userId)
      if (!recipient?.email) {
        // -> `debug`: recurs on every run for the same account (see `notify-event-subscribers.ts`).
        WIKI.logger.debug('hooks', 'immediate watch notification skipped, no email address', {
          page: pageId,
          user: watcher.userId
        })
        continue
      }
      await WIKI.models.mail.sendPageWatchNotification({
        to: recipient.email,
        siteId,
        page: { title: pageTitle, path: pagePath, locale: pageLocale },
        action,
        changedFields,
        actorName,
        userId: watcher.userId,
        locale: (recipient.prefs as Record<string, any> | undefined)?.locale
      })
      await WIKI.models.pageWatchEvents.markDelivered(eventId)
    } catch (err: any) {
      // -> Logged loudly, not thrown: the pending row above already guarantees this is not lost, and
      //    throwing here would retry `recordMany` too (see this file's own doc comment).
      WIKI.logger.error('hooks', 'failed to send immediate watch notification', {
        page: pageId,
        user: watcher.userId,
        error: err
      })
    }
  }
}
