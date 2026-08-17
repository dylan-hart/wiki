import type { WatchEventItem } from '../../models/mail.ts'
import type { PendingDigestEvent } from '../../models/pageWatchEvents.ts'

/**
 * Send one batched email per `digest`-mode watcher, covering every pending page-watch notification
 * across every page they watch, then mark exactly those notifications delivered.
 *
 * Scheduled daily (see `models/jobs.ts#init`'s `jobSchedule` seed) rather than run inline anywhere:
 * unlike an immediate send (`tasks/simple/notify-page-watchers.ts`, one watcher, one change, sent
 * right after it happens), a digest by definition waits and batches, so it has to be driven by the
 * clock rather than by any single page change.
 *
 * `WIKI.models.pageWatchEvents.listPendingForDigest()` already filters to `notifyMode: 'digest'` and
 * `deliveredAt IS NULL` — see that model's own comment on why an `immediate`-mode row can also be
 * pending (a failed send, left for a future in-app inbox) and must never be swept into a digest. A
 * user who owns none of those rows this cycle simply never appears in the grouping below, which is
 * what keeps "nothing pending" a no-op rather than an empty email: there is no branch here that sends
 * unconditionally.
 *
 * Each user's send is isolated in its own `try`/`catch`, the same shape `notifyPageWatchers` uses for
 * its per-recipient sends and for the same reason: one watcher's misconfigured/bounced/unreachable
 * mailbox must not stop every other watcher's digest in the same run, and must not be "fixed" by
 * retrying the whole job — a retry would re-send every digest that already went out this run, not
 * just the one that failed. A failed user's events are simply left pending; the next day's scheduled
 * run picks them up again alongside whatever accumulated since.
 *
 * Composes each line of the digest via `WIKI.models.mail.sendPageWatchDigest`, which itself builds
 * every line through the exact same per-event content `sendPageWatchNotification` sends alone — this
 * task supplies the data (grouped events, resolved actor names) but never re-derives the phrasing.
 */
export async function task(): Promise<void> {
  WIKI.logger.info('Sending page watch digests...')

  try {
    const pending = await WIKI.models.pageWatchEvents.listPendingForDigest()

    const eventsByUser = new Map<string, PendingDigestEvent[]>()
    for (const event of pending) {
      const events = eventsByUser.get(event.userId)
      if (events) {
        events.push(event)
      } else {
        eventsByUser.set(event.userId, [event])
      }
    }

    if (eventsByUser.size < 1) {
      WIKI.logger.info('Sending page watch digests: [ COMPLETED ] (nothing pending)')
      return
    }

    // -> Resolved once per actor per run, not once per event: several pending events in the same
    //    digest, or across several users' digests, very plausibly share the same actor.
    const actorNames = new Map<string, string>()
    async function resolveActorName(actorId: string | null): Promise<string> {
      if (!actorId) {
        return 'Someone'
      }
      const cached = actorNames.get(actorId)
      if (cached) {
        return cached
      }
      const actorUser = await WIKI.models.users.getById(actorId)
      const name = actorUser?.name ?? 'Someone'
      actorNames.set(actorId, name)
      return name
    }

    let sent = 0
    for (const [userId, events] of eventsByUser) {
      try {
        const recipient = await WIKI.models.users.getById(userId)
        if (!recipient?.email) {
          WIKI.logger.warn(`Skipping watch digest for user ${userId}: no email address.`)
          continue
        }

        const items: WatchEventItem[] = []
        for (const event of events) {
          items.push({
            page: { title: event.pageTitle, path: event.pagePath },
            action: event.action,
            changedFields: event.changedFields,
            actorName: await resolveActorName(event.actorId)
          })
        }

        await WIKI.models.mail.sendPageWatchDigest({ to: recipient.email, items })
        await WIKI.models.pageWatchEvents.markManyDelivered(events.map((event) => event.id))
        sent++
      } catch (err: any) {
        // -> Logged loudly, not thrown: the pending events survive either way (nothing here marks
        //    them delivered before the send succeeds), which is what keeps one watcher's failed
        //    digest from retrying — and re-sending — every other watcher's digest in this same run.
        WIKI.logger.error(`Sending watch digest to user ${userId}: [ FAILED ]`)
        WIKI.logger.error(err.message)
      }
    }

    WIKI.logger.info(
      `Sending page watch digests: [ COMPLETED ] (${sent}/${eventsByUser.size} digest(s) sent)`
    )
  } catch (err: any) {
    WIKI.logger.error('Sending page watch digests: [ FAILED ]')
    WIKI.logger.error(err.message)
    throw err
  }
}
