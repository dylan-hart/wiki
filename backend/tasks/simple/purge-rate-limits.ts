import type { TaskResult } from '../../core/scheduler.ts'

export async function task(): Promise<TaskResult | void> {
  const purged = await WIKI.models.rateLimits.purgeStale()
  if (purged > 0) {
    return { summary: 'purged stale rate limit counters', purged }
  }
}
