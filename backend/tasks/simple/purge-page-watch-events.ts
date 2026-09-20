import type { TaskResult } from '../../core/scheduler.ts'

/**
 * The retention window is comfortably longer than the in-app inbox's or the digest job's useful
 * history, so an undelivered backlog — a permanently-failed send, a digest recipient who never looks
 * at their inbox — cannot accumulate forever.
 */
export async function task(): Promise<TaskResult | void> {
  const count = await CARDINAL.models.pageWatchEvents.purgeExpired()
  if (count > 0) {
    return { summary: 'purged page watch events past the retention window', purged: count }
  }
}
