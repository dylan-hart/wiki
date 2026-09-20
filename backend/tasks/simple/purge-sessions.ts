import type { TaskResult } from '../../core/scheduler.ts'

/**
 * An expired cookie simply stops being presented, so nothing else ever revisits its `sessions` row.
 */
export async function task(): Promise<TaskResult | void> {
  const count = await CARDINAL.models.sessions.purgeExpiredSessions()
  if (count > 0) {
    return { summary: 'purged sessions past the cookie window', purged: count }
  }
}
