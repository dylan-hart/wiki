/**
 * Sweep `sessions` rows past the cookie's 30-day window (OpenProject #2248) -- an expired cookie
 * simply stops being presented, so nothing else ever revisits the row. Mirrors
 * `purge-rate-limits.ts` / `purge-pageviews.ts`'s shape: a single model call, logged only when it
 * actually removed something.
 */
export async function task(): Promise<void> {
  const count = await WIKI.models.sessions.purgeExpiredSessions()
  if (count > 0) {
    WIKI.logger.info('session', 'purged sessions past the cookie window', { purged: count })
  }
}
