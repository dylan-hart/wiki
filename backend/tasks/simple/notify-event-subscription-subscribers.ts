import type { HookEvent } from '../../models/hooks.ts'

/** What `models/hooks.ts#emit()` queues after resolving an `eventSubscriptions`-table subscriber
 *  list -- the `notifyEventSubscriptionSubscribers` task's own payload, distinct from
 *  `notify-event-subscribers.ts`'s `NotifyEventSubscribersPayload` (see this file's own doc comment
 *  for why the two stay separate tasks). */
export interface NotifyEventSubscriptionSubscribersPayload {
  event: HookEvent | string
  /** Event-specific payload, exactly as passed to `emit()` -- carried along for a future, richer
   *  per-event template (Feature #2425's "email transport/templating" child) to draw on; the
   *  generic template this sends today does not read it. */
  data: Record<string, any>
  subscriberIds: string[]
}

/**
 * Send an immediate notification email to every user subscribed (`models/eventSubscriptions.ts`) to
 * an event that just fired.
 *
 * Queued by `models/hooks.ts#Hooks.emit()`'s `queueEventSubscriberNotifications()`, one job per
 * event with subscribers, the same batching `tasks/simple/notify-page-watchers.ts` uses for a page's
 * watchers -- so an event with many subscribers costs the triggering request nothing beyond the one
 * job it queues.
 *
 * A separate task from `notify-event-subscribers.ts` (OpenProject #2481's `users.prefs.notifications
 * .events`-backed email fan-out) on purpose: the two read from different subscription stores and are
 * queued with differently-shaped payloads, so folding them into one task would mean that task
 * guessing which shape it received.
 *
 * Each recipient is resolved and sent to independently: one subscriber having no email address, or
 * one send failing, is logged and skipped rather than aborting the rest of the batch -- the same
 * per-recipient isolation `notify-page-watchers.ts` uses, and for the same reason (an unrelated
 * subscriber must still get their mail).
 */
export async function task(payload?: NotifyEventSubscriptionSubscribersPayload): Promise<void> {
  if (!payload || payload.subscriberIds.length < 1) {
    return
  }
  const { event, subscriberIds } = payload

  for (const userId of subscriberIds) {
    try {
      const recipient = await WIKI.models.users.getById(userId)
      if (!recipient?.email) {
        // -> `debug`: recurs on every run for the same account (see `notify-event-subscribers.ts`).
        WIKI.logger.debug('hooks', 'event-subscription notification skipped, no email address', {
          user: userId,
          event
        })
        continue
      }
      await WIKI.models.mail.sendEventSubscriptionNotification({
        to: recipient.email,
        event,
        userId,
        locale: (recipient.prefs as Record<string, any> | undefined)?.locale
      })
    } catch (err: any) {
      WIKI.logger.error('hooks', 'failed to send event-subscription notification', {
        user: userId,
        event,
        error: err
      })
    }
  }
}
