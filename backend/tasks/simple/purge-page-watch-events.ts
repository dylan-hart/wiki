/**
 * Sweep `pageWatchEvents` rows older than the 90-day retention window (OpenProject #1689) —
 * comfortably longer than the in-app inbox's or the digest job's useful history, so an undelivered
 * backlog (a permanently-failed send, or a digest recipient who never checks their in-app inbox)
 * cannot accumulate forever. Mirrors `purge-pageviews.ts`'s shape: a single model call, logged only
 * when it actually removed something.
 */
export async function task(): Promise<void> {
  const count = await WIKI.models.pageWatchEvents.purgeExpired()
  if (count > 0) {
    WIKI.logger.info('pages', 'purged page watch events past the retention window', {
      purged: count
    })
  }
}
