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
  WIKI.logger.info('Running scheduled daily storage backups...')

  try {
    const { ran, failed } = await WIKI.models.storage.runDailyBackups()

    WIKI.logger.info(
      `Ran ${ran} scheduled daily storage backup(s), ${failed} failed: [ COMPLETED ]`
    )
  } catch (err: any) {
    WIKI.logger.error('Running scheduled daily storage backups: [ FAILED ]')
    WIKI.logger.error(err.message)
    throw err
  }
}
