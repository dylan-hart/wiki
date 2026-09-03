import type { HookEvent } from '../../models/hooks.ts'

/** What `models/hooks.ts#emit()` queues after resolving an event's subscriber list. */
export interface NotifyEventSubscribersPayload {
  event: HookEvent | string
  /** Event-specific payload, exactly as passed to `emit()` -- carried along for a future, richer
   *  per-event template (Feature #2425's "email transport/templating" child) to draw on; the
   *  generic template this sends today does not read it. */
  data: Record<string, any>
  subscriberIds: string[]
}

/**
 * Send an immediate notification email to every user subscribed to an event that just fired.
 *
 * Queued by `models/hooks.ts#emit()`, one job per event with subscribers, the same batching
 * `tasks/simple/notify-page-watchers.ts` uses for a page's watchers -- so an event with many
 * subscribers costs the triggering request nothing beyond the one job it queues.
 *
 * Each recipient is resolved and sent to independently: one subscriber having no email address, or
 * one send failing, is logged and skipped rather than aborting the rest of the batch -- the same
 * per-recipient isolation `notify-page-watchers.ts` uses, and for the same reason (an unrelated
 * subscriber must still get their mail).
 */
export async function task(payload?: NotifyEventSubscribersPayload): Promise<void> {
  if (!payload || payload.subscriberIds.length < 1) {
    return
  }
  const { event, subscriberIds } = payload

  for (const userId of subscriberIds) {
    try {
      const recipient = await WIKI.models.users.getById(userId)
      if (!recipient?.email) {
        WIKI.logger.warn(
          `Skipping event-subscription notification for ${event}: user ${userId} has no email address.`
        )
        continue
      }
      await WIKI.models.mail.sendEventSubscriptionNotification({
        to: recipient.email,
        event,
        locale: (recipient.prefs as Record<string, any> | undefined)?.locale
      })
    } catch (err: any) {
      WIKI.logger.error(
        `Sending event-subscription notification to user ${userId} for ${event}: [ FAILED ]`
      )
      WIKI.logger.error(err.message)
    }
  }
}
