import type { TaskResult } from '../../core/scheduler.ts'

export async function task(): Promise<TaskResult | void> {
  const purged = await CARDINAL.models.comments.purgeGuestPii(
    CARDINAL.models.comments.getGuestPiiRetentionDays()
  )
  if (purged > 0) {
    return { summary: 'purged guest comment PII past the retention window', purged }
  }
}
