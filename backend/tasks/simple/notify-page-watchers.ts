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
  action: PageWatchNotifiableAction
  /** Empty for a move or delete — nothing about the page's content changed. */
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
 */
export async function task(payload?: NotifyPageWatchersPayload): Promise<void> {
  if (!payload || payload.watchers.length < 1) {
    return
  }
  const { siteId, pageId, pageTitle, pagePath, action, changedFields, actorId, watchers } = payload

  let recorded: { id: string; userId: string }[]
  try {
    recorded = await WIKI.models.pageWatchEvents.recordMany(
      watchers.map((watcher) => ({
        siteId,
        pageId,
        pageTitle,
        pagePath,
        userId: watcher.userId,
        action,
        actorId,
        changedFields,
        notifyMode: watcher.notifyMode
      }))
    )
  } catch (err: any) {
    WIKI.logger.error(`Recording page watch notifications for page ${pageId}: [ FAILED ]`)
    WIKI.logger.error(err.message)
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
    try {
      const recipient = await WIKI.models.users.getById(watcher.userId)
      if (!recipient?.email) {
        WIKI.logger.warn(
          `Skipping immediate watch notification for page ${pageId}: user ${watcher.userId} has no email address.`
        )
        continue
      }
      await WIKI.models.mail.sendPageWatchNotification({
        to: recipient.email,
        page: { title: pageTitle, path: pagePath },
        action,
        changedFields,
        actorName
      })
      await WIKI.models.pageWatchEvents.markDelivered(eventId)
    } catch (err: any) {
      // -> Logged loudly, not thrown: the pending row above already guarantees this is not lost, and
      //    throwing here would retry `recordMany` too (see this file's own doc comment).
      WIKI.logger.error(
        `Sending immediate watch notification to user ${watcher.userId} for page ${pageId}: [ FAILED ]`
      )
      WIKI.logger.error(err.message)
    }
  }
}
