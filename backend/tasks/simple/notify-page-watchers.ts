import type { PageWatchNotifiableAction, RecordedWatchEvent } from '../../models/pageWatchEvents.ts'
import type { WatchNotifyMode } from '../../models/pageWatching.ts'

export interface QueuedWatcher {
  userId: string
  notifyMode: WatchNotifyMode
}

export interface NotifyPageWatchersPayload {
  siteId: string
  pageId: string
  pageTitle: string
  pagePath: string
  pageLocale: string
  action: PageWatchNotifiableAction
  /** Up to `['path', 'locale', 'title']` for a move, empty for a delete. */
  changedFields: string[]
  actorId: string
  watchers: QueuedWatcher[]
  /**
   * For a `deleted` event: the rows `notifyWatchers` recorded synchronously, while the page row still
   * existed — `pageWatchEvents.pageId` is a foreign key, and this job runs too late to promise its
   * referent is still there. When present, `recordMany()` is skipped entirely rather than re-run.
   */
  recordedEvents?: RecordedWatchEvent[]
}

/**
 * The watcher list, already paired with each watcher's resolved `notifyMode`, is resolved by
 * `notifyWatchers` before this is queued: a page cascade-deletes its watch rows, so re-resolving the
 * watchers — or `page`/`changedFields` — here would find nothing left for a `deleted` event. What is
 * left for this job is the part that scales with how many people watch the page: one
 * `pageWatchEvents` row per watcher and, for the `immediate` ones, the mail itself.
 *
 * A `digest`-mode watcher's row is left with `deliveredAt` null for the digest job to send later; an
 * `immediate` one is marked delivered on a successful send, so the digest never re-sends it.
 *
 * A failed send is logged and left pending rather than thrown: the row survives either way, so the
 * notification is not lost, and throwing would retry the whole payload — including `recordMany`,
 * inserting a duplicate pending row for every watcher rather than just the one that failed.
 *
 * `read:pages` is re-checked right before the immediate send, because a scheduler backlog can put
 * real time between `notifyWatchers`'s own check at page-change time and this job running. It falls
 * back to the payload's `pagePath`/`pageLocale` for a `deleted` action, whose page row is already
 * gone. Only the immediate send is gated; the digest job re-checks at its own, later send time.
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
    watchers,
    recordedEvents
  } = payload

  let recorded: RecordedWatchEvent[]
  try {
    recorded = recordedEvents
      ? recordedEvents
      : await CARDINAL.models.pageWatchEvents.recordMany(
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
    CARDINAL.logger.error('hooks', 'failed to record page watch notifications', {
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
  const actorUser = await CARDINAL.models.users.getById(actorId)
  const actorName = actorUser?.name ?? 'Someone'

  for (const watcher of immediateWatchers) {
    const eventId = eventIdByUserId.get(watcher.userId)
    if (!eventId) {
      continue
    }
    // -> A single-item batch: `filterReadable` is keyed to one user's events, and each watcher here
    //    is a different user.
    const readable = await CARDINAL.models.pageWatchEvents.filterReadable(watcher.userId, [
      { pageId, pagePath, pageLocale, siteId }
    ])
    if (readable.length < 1) {
      continue
    }
    try {
      const recipient = await CARDINAL.models.users.getById(watcher.userId)
      if (!recipient?.email) {
        // -> `debug`: recurs on every run for the same account.
        CARDINAL.logger.debug('hooks', 'immediate watch notification skipped, no email address', {
          page: pageId,
          user: watcher.userId
        })
        continue
      }
      await CARDINAL.models.mail.sendPageWatchNotification({
        to: recipient.email,
        siteId,
        page: { title: pageTitle, path: pagePath, locale: pageLocale },
        action,
        changedFields,
        actorName,
        userId: watcher.userId,
        locale: (recipient.prefs as Record<string, any> | undefined)?.locale
      })
      await CARDINAL.models.pageWatchEvents.markDelivered(eventId)
    } catch (err: any) {
      // -> Not thrown: the pending row already guarantees this is not lost, and a retry would re-run
      //    `recordMany` too.
      CARDINAL.logger.error('hooks', 'failed to send immediate watch notification', {
        page: pageId,
        user: watcher.userId,
        error: err
      })
    }
  }
}
