/**
 * Pulls a fresh full snapshot from the configured source instance and wipes-and-replaces this
 * instance's own data with it -- queued by `replicationTick` (see `models/jobs.ts`'s
 * `JOB_SCHEDULE_SEED` and `models/replication.ts#tick()`), or on demand via the scheduler admin
 * view's "run now".
 */
export async function task(): Promise<void> {
  try {
    await WIKI.models.replication.pull()
  } catch (err: any) {
    WIKI.logger.error('Replication pull: [ FAILED ]')
    WIKI.logger.error(err.message)
    throw err
  }
}
