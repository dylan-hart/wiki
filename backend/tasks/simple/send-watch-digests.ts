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
 * Grouped by `(userId, siteId)`, not `userId` alone: a watcher's pending events can span more than one
 * site, and each site can have its own locale routing config, so one digest email must never mix
 * events from two sites — `WIKI.models.mail.sendPageWatchDigest` resolves that config once per send
 * from a single `siteId`, which is only ever correct if every item in the send shares it.
 *
 * Composes each line of the digest via `WIKI.models.mail.sendPageWatchDigest`, which itself builds
 * every line through the exact same per-event content `sendPageWatchNotification` sends alone — this
 * task supplies the data (grouped events, resolved actor names) but never re-derives the phrasing.
 *
 * OpenProject #2173: a digest is a `read:pages` re-check's worst case for staleness — a `digest`-mode
 * event sits pending for up to a full day (this job's own schedule) between being recorded and being
 * sent, the longest window anywhere in this feature for a watcher's group membership or the page's
 * rules to have changed underneath it. `WIKI.models.pageWatchEvents.filterReadable()` (shared with the
 * in-app inbox's own read-time re-check, `listForUser`) is applied per `(userId, siteId)` group, right
 * before that group's items are built — an event that fails it is marked delivered anyway (there is
 * nothing further to tell a watcher about a page they can no longer read) but never appears in the
 * mail, and a group left with nothing readable is skipped entirely rather than sending an empty digest.
 */
export async function task(): Promise<void> {
  const pending = await WIKI.models.pageWatchEvents.listPendingForDigest()

  // -> Keyed by `userId\0siteId`, not `userId` alone — see this file's own doc comment on why a
  //    digest must never mix events from two sites into one send.
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
    // -> The common case on a quiet wiki, every run: nothing happened, so nothing is said at
    //    `info` (audit X1/X2).
    WIKI.logger.debug('hooks', 'no page watch digests pending')
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
  for (const events of eventsByUserSite.values()) {
    const userId = events[0]!.userId
    const siteId = events[0]!.siteId
    try {
      // -> OpenProject #2173: re-check read:pages right before sending, not just when each event
      //    was recorded. An event that no longer passes is marked delivered along with the rest of
      //    this group's readable ones -- there is nothing further to tell this watcher about a page
      //    they can no longer read, and leaving it pending would only have it re-evaluated (and
      //    re-filtered out) by every future run indefinitely.
      const readable = await WIKI.models.pageWatchEvents.filterReadable(userId, events)
      const unreadable = events.filter((event) => !readable.includes(event))
      if (unreadable.length > 0) {
        await WIKI.models.pageWatchEvents.markManyDelivered(unreadable.map((event) => event.id))
      }
      if (readable.length < 1) {
        continue
      }

      const recipient = await WIKI.models.users.getById(userId)
      if (!recipient?.email) {
        // -> `debug`: recurs on every run for the same account.
        WIKI.logger.debug('hooks', 'watch digest skipped, no email address', { user: userId })
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

      await WIKI.models.mail.sendPageWatchDigest({
        to: recipient.email,
        siteId,
        items,
        locale: (recipient.prefs as Record<string, any> | undefined)?.locale
      })
      await WIKI.models.pageWatchEvents.markManyDelivered(readable.map((event) => event.id))
      sent++
    } catch (err: any) {
      // -> Logged loudly, not thrown: the pending events survive either way (nothing here marks
      //    them delivered before the send succeeds), which is what keeps one watcher's failed
      //    digest from retrying — and re-sending — every other watcher's digest in this same run.
      WIKI.logger.error('hooks', 'failed to send watch digest', {
        user: userId,
        site: siteId,
        error: err
      })
    }
  }

  if (sent > 0) {
    WIKI.logger.info('hooks', 'sent page watch digests', { sent, of: eventsByUserSite.size })
  } else {
    WIKI.logger.debug('hooks', 'no page watch digest was sent', { of: eventsByUserSite.size })
  }
}
