import type { TaskResult } from '../../core/scheduler.ts'

/**
 * The whole instance — every site, not one — for clean-slate replication's source side.
 *
 * Queued from `POST /_api/system/replication/export` rather than run inline: a whole instance's
 * worth of asset bytes is not something a request thread should be blocked on. `jobId` is this
 * task's own `jobHistory` row, and recording the result on it is what lets
 * `GET /_api/system/replication/export/:jobId/download` find the finished file.
 */
export async function task(_payload: unknown = {}, jobId?: string): Promise<TaskResult> {
  // -> Announced at `debug` because a whole instance's assets can take minutes; the failure
  //    propagates to the scheduler, which writes the one record for it.
  CARDINAL.logger.debug('storage', 'building instance-wide replication snapshot')
  const result = await CARDINAL.models.replicationExport.buildSnapshot()
  // -> The history row carries `{ filePath, fileSize }` for the download route; the returned summary
  //    only becomes a log line.
  if (jobId) {
    await CARDINAL.models.jobs.setResult(jobId, result)
  }
  return { summary: 'built instance-wide replication snapshot', bytes: result.fileSize }
}
