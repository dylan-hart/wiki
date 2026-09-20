import type { WatchEventItem } from '../../models/mail.ts'
import type { PendingDigestEvent } from '../../models/pageWatchEvents.ts'
import type { TaskResult } from '../../core/scheduler.ts'

export async function task(): Promise<TaskResult | void> {
  const pending = await CARDINAL.models.pageWatchEvents.listPendingForDigest()

  // -> Keyed by `userId\0siteId`, not `userId` alone: `sendPageWatchDigest` resolves one site's
  //    locale routing config per send, so a single email must never mix two sites' events.
  const eventsByUserSite = new Map<string, PendingDigestEvent[]>()
  for (const event of pending) {
    const key = `${event.userId}\0${event.siteId}`
    const events = eventsByUserSite.get(key)
    if (events) {
      events.push(event)
    } else {
      eventsByUserSite.set(key, [event])
    }
  }

  if (eventsByUserSite.size < 1) {
    CARDINAL.logger.debug('hooks', 'no page watch digests pending')
    return
  }

  const actorNames = new Map<string, string>()
  async function resolveActorName(actorId: string | null): Promise<string> {
    if (!actorId) {
      return 'Someone'
    }
    const cached = actorNames.get(actorId)
    if (cached) {
      return cached
    }
    const actorUser = await CARDINAL.models.users.getById(actorId)
    const name = actorUser?.name ?? 'Someone'
    actorNames.set(actorId, name)
    return name
  }

  let sent = 0
  for (const events of eventsByUserSite.values()) {
    const userId = events[0]!.userId
    const siteId = events[0]!.siteId
    try {
      // -> `read:pages` is re-checked at send time: an event can sit pending for a full day, long
      //    enough for the watcher's groups or the page's rules to have changed. One that no longer
      //    passes is marked delivered rather than left to be re-filtered out forever.
      const readable = await CARDINAL.models.pageWatchEvents.filterReadable(userId, events)
      const unreadable = events.filter((event) => !readable.includes(event))
      if (unreadable.length > 0) {
        await CARDINAL.models.pageWatchEvents.markManyDelivered(unreadable.map((event) => event.id))
      }
      if (readable.length < 1) {
        continue
      }

      const recipient = await CARDINAL.models.users.getById(userId)
      if (!recipient?.email) {
        CARDINAL.logger.debug('hooks', 'watch digest skipped, no email address', { user: userId })
        continue
      }

      const items: WatchEventItem[] = []
      for (const event of readable) {
        items.push({
          page: { title: event.pageTitle, path: event.pagePath, locale: event.pageLocale },
          action: event.action,
          changedFields: event.changedFields,
          actorName: await resolveActorName(event.actorId)
        })
      }

      await CARDINAL.models.mail.sendPageWatchDigest({
        to: recipient.email,
        siteId,
        items,
        userId,
        locale: (recipient.prefs as Record<string, any> | undefined)?.locale
      })
      await CARDINAL.models.pageWatchEvents.markManyDelivered(readable.map((event) => event.id))
      sent++
    } catch (err: any) {
      // -> Logged, not thrown: a job retry would re-send every digest that already went out this
      //    run. This user's events stay pending and the next run picks them up.
      CARDINAL.logger.error('hooks', 'failed to send watch digest', {
        user: userId,
        site: siteId,
        error: err
      })
    }
  }

  if (sent > 0) {
    return { summary: 'sent page watch digests', sent, of: eventsByUserSite.size }
  }
  // -> Had work in hand and sent none of it (unreadable, or no address on file) — worth its own
  //    line, but not an `info` summary.
  CARDINAL.logger.debug('hooks', 'no page watch digest was sent', { of: eventsByUserSite.size })
}
