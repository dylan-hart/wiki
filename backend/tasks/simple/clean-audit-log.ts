import type { TaskResult } from '../../core/scheduler.ts'

export async function task(): Promise<TaskResult | void> {
  const purged = await CARDINAL.models.auditLog.purge(CARDINAL.models.auditLog.getRetentionDays())
  if (purged > 0) {
    return { summary: 'purged audit log entries past the retention window', purged }
  }
}
