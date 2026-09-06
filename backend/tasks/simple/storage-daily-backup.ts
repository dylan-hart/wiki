import type { TaskResult } from '../../core/scheduler.ts'

/**
 * Run the `dailyBackup` handler for every enabled storage target that opts into it, across every
 * site.
 *
 * Queued daily by the `storageDailyBackup` cron entry (`models/jobs.ts`). Runs in-process, like every
 * `tasks/simple/` task — the actual enumeration/filtering/invocation lives in
 * `Storage.runDailyBackups()`, the same "thin task, real logic on the model" split
 * `storage-sync-tick.ts` uses for `tickScheduledSyncs()`.
 */
export async function task(): Promise<TaskResult | void> {
  const { ran, failed } = await WIKI.models.storage.runDailyBackups()
  // -> Silent when there was nothing to back up: a target that opts out of `dailyBackup` should not
  //    put a line in the log every day saying so.
  // -> The partly-failed run keeps a log call of its own rather than becoming a returned summary:
  //    a backup that did not run is degraded rather than broken, and `warn` is the level that says
  //    so, which the scheduler's summary line (always `info`) cannot express. The target's own
  //    module already logged why each one failed.
  if (failed > 0) {
    WIKI.logger.warn('storage', 'ran scheduled daily backups, some failed', { ran, failed })
    return
  }
  if (ran > 0) {
    return { summary: 'ran scheduled daily backups', ran }
  }
}
