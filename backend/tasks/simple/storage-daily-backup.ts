import type { TaskResult } from '../../core/scheduler.ts'

export async function task(): Promise<TaskResult | void> {
  const { ran, failed } = await CARDINAL.models.storage.runDailyBackups()
  // -> A partly-failed run warns instead of returning a summary: it is degraded rather than broken,
  //    and the scheduler's summary line is always `info`. Nothing to back up stays silent.
  if (failed > 0) {
    CARDINAL.logger.warn('storage', 'ran scheduled daily backups, some failed', { ran, failed })
    return
  }
  if (ran > 0) {
    return { summary: 'ran scheduled daily backups', ran }
  }
}
