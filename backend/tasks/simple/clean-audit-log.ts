import type { TaskResult } from '../../core/scheduler.ts'

export async function task(): Promise<TaskResult | void> {
  const purged = await WIKI.models.auditLog.purge(WIKI.models.auditLog.getRetentionDays())
  if (purged > 0) {
    return { summary: 'purged audit log entries past the retention window', purged }
  }
}
