import type { HookEvent } from '../../models/hooks.ts'

/** One subscriber this event is queued for — resolved by `Hooks.emit()` before queueing, the same
 *  "resolve once, deliver from the resolved list" convention `NotifyPageWatchersPayload.watchers`
 *  uses in `notify-page-watchers.ts`. */
export interface QueuedEmailSubscriber {
  userId: string
}

/** What `models/hooks.ts#Hooks.emit()`'s `notifyEmailSubscribers()` queues for every event with at
 *  least one email subscriber. */
export interface NotifyEventSubscribersPayload {
  event: HookEvent
  siteId: string | null
  data: Record<string, unknown>
  subscribers: QueuedEmailSubscriber[]
}

/**
 * Email every user subscribed (`prefs.notifications.events`) to an event `Hooks.emit()` just fired.
 *
 * Runs in-process (`tasks/simple/`), not a worker thread: sending mail here is the same kind of I/O
 * `notify-page-watchers.ts`'s immediate-send loop already does in-process — not the
 * `DELIVERY_TIMEOUT`-bounded arbitrary-remote-endpoint wait `dispatch-webhook.ts` exists to isolate
 * onto a worker thread (see that task's own doc comment).
 *
 * A failed send is logged and the loop continues onto the next subscriber — one bad address or a
 * momentarily-down SMTP server must not stop the rest of the batch. Unlike a page-watch
 * notification, there is no persisted "pending" row behind this to retry against later: a failed
 * send here is simply lost, the same way a rate-limited webhook delivery is skipped rather than
 * queued (see `Hooks.emit()`'s own doc comment) — building that durability is a larger scope this
 * deliberately stays out of.
 */
export async function task(payload?: NotifyEventSubscribersPayload): Promise<void> {
  if (!payload || payload.subscribers.length < 1) {
    return
  }
  const { event, siteId, data, subscribers } = payload

  for (const { userId } of subscribers) {
    try {
      const recipient = await WIKI.models.users.getById(userId)
      if (!recipient?.email) {
        // -> `debug`: the same account with no e-mail address recurs on every run, so this is a
        //    per-item fact rather than something an operator has to act on.
        WIKI.logger.debug('hooks', 'notification skipped, no email address', {
          user: userId,
          event
        })
        continue
      }
      await WIKI.models.mail.sendEventNotification({
        to: recipient.email,
        event,
        siteId,
        data,
        userId,
        locale: (recipient.prefs as Record<string, any> | undefined)?.locale
      })
    } catch (err: any) {
      WIKI.logger.error('hooks', 'failed to send event notification', {
        user: userId,
        event,
        error: err
      })
    }
  }
}
