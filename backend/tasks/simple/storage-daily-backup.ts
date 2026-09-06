/**
 * Run the `dailyBackup` handler for every enabled storage target that opts into it, across every
 * site.
 *
 * Queued daily by the `storageDailyBackup` cron entry (`models/jobs.ts`). Runs in-process, like every
 * `tasks/simple/` task — the actual enumeration/filtering/invocation lives in
 * `Storage.runDailyBackups()`, the same "thin task, real logic on the model" split
 * `storage-sync-tick.ts` uses for `tickScheduledSyncs()`.
 */
export async function task(): Promise<void> {
  const { ran, failed } = await WIKI.models.storage.runDailyBackups()
  // -> Silent when there was nothing to back up: a target that opts out of `dailyBackup` should not
  //    put a line in the log every day saying so. `failed` is a `warn`, since a backup that did not
  //    run is degraded rather than broken — the target's own module logged why.
  if (failed > 0) {
    WIKI.logger.warn('storage', 'ran scheduled daily backups, some failed', { ran, failed })
  } else if (ran > 0) {
    WIKI.logger.info('storage', 'ran scheduled daily backups', { ran })
  }
}
