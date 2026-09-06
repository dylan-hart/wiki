/**
 * Pulls a fresh full snapshot from the configured source instance and wipes-and-replaces this
 * instance's own data with it -- queued by `replicationTick` (see `models/jobs.ts`'s
 * `JOB_SCHEDULE_SEED` and `models/replication.ts#tick()`), or on demand via the scheduler admin
 * view's "run now".
 */
export async function task(): Promise<void> {
  // -> No try/catch: `pull()`'s own failure propagates, and the scheduler writes the one record for
  //    it with the job id and attempt attached. A second, contextless pair here said less.
  await WIKI.models.replication.pull()
}
