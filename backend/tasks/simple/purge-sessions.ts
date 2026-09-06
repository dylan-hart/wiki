import type { TaskResult } from '../../core/scheduler.ts'

/**
 * Sweep `sessions` rows past the cookie's 30-day window (OpenProject #2248) -- an expired cookie
 * simply stops being presented, so nothing else ever revisits the row. Mirrors
 * `purge-rate-limits.ts` / `purge-pageviews.ts`'s shape: a single model call, and a summary handed
 * back only when it actually removed something.
 */
export async function task(): Promise<TaskResult | void> {
  const count = await WIKI.models.sessions.purgeExpiredSessions()
  if (count > 0) {
    return { summary: 'purged sessions past the cookie window', purged: count }
  }
}
