import type { TaskResult } from '../../core/scheduler.ts'

/**
 * The retention window matches the knowledge graph's longest trailing window, so "all-time" and that
 * window are the same query once this has run.
 */
export async function task(): Promise<TaskResult | void> {
  const count = await CARDINAL.models.pageviews.purgeExpired()
  if (count > 0) {
    return { summary: 'purged pageviews past the retention window', purged: count }
  }
}
