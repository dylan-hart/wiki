import type { HookEvent } from '../../models/hooks.ts'

/** Resolved by `Hooks.emit()` before queueing; this task looks up no subscriptions of its own. */
export interface QueuedEmailSubscriber {
  userId: string
}

export interface NotifyEventSubscribersPayload {
  event: HookEvent
  siteId: string | null
  data: Record<string, unknown>
  subscribers: QueuedEmailSubscriber[]
}

/**
 * Emails the users subscribed through `prefs.notifications.events`. Runs in-process, not on a worker
 * thread: sending mail is ordinary I/O, not the `DELIVERY_TIMEOUT`-bounded wait on an arbitrary
 * remote endpoint that `dispatch-webhook.ts` is isolated onto a thread for.
 *
 * A failed send is logged and the loop continues — one bad address or a momentarily-down SMTP server
 * must not stop the rest of the batch. There is no persisted pending row behind this, so a failed
 * send is simply lost; durable retry is a larger scope this deliberately stays out of.
 */
export async function task(payload?: NotifyEventSubscribersPayload): Promise<void> {
  if (!payload || payload.subscribers.length < 1) {
    return
  }
  const { event, siteId, data, subscribers } = payload

  for (const { userId } of subscribers) {
    try {
      const recipient = await CARDINAL.models.users.getById(userId)
      if (!recipient?.email) {
        // -> `debug`: the same address-less account recurs on every run, so this is a per-item fact
        //    rather than something an operator has to act on.
        CARDINAL.logger.debug('hooks', 'notification skipped, no email address', {
          user: userId,
          event
        })
        continue
      }
      await CARDINAL.models.mail.sendEventNotification({
        to: recipient.email,
        event,
        siteId,
        data,
        userId,
        locale: (recipient.prefs as Record<string, any> | undefined)?.locale
      })
    } catch (err: any) {
      CARDINAL.logger.error('hooks', 'failed to send event notification', {
        user: userId,
        event,
        error: err
      })
    }
  }
}
