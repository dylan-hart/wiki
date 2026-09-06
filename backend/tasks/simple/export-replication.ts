/**
 * Serialize the whole instance — every site, not one — into a downloadable snapshot tarball under
 * `<dataPath>/exports/`, for Epic #2437's scheduled clean-slate replication (source side, WP #2489).
 *
 * Queued from `POST /_api/system/replication/export` rather than run inline: a whole instance's
 * worth of asset bytes is not something a request thread should be blocked on. `jobId` is this
 * task's own row in `jobHistory` (see `core/scheduler.ts`'s `SimpleTask`) — recording the result on
 * it is what lets `GET /_api/system/replication/export/:jobId/download` find the finished file.
 */
export async function task(_payload: unknown = {}, jobId?: string): Promise<void> {
  // -> Announced at `debug` because a whole instance's assets can take minutes; the failure
  //    propagates to the scheduler, which writes the one record for it.
  WIKI.logger.debug('storage', 'building instance-wide replication snapshot')
  const result = await WIKI.models.replicationExport.buildSnapshot()
  if (jobId) {
    await WIKI.models.jobs.setResult(jobId, result)
  }
  WIKI.logger.info('storage', 'built instance-wide replication snapshot')
}
