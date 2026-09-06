import type { TaskResult } from '../../core/scheduler.ts'

/**
 * Serialize one site's content into a downloadable tarball under `<dataPath>/exports/`.
 *
 * Queued from `POST /_api/system/export` rather than run inline: a whole site's worth of asset bytes
 * is not something a request thread should be blocked on. `jobId` is this task's own row in
 * `jobHistory` (see `core/scheduler.ts`'s `SimpleTask`) — recording the result on it is what lets
 * `GET /_api/system/export/:jobId/download` find the finished file.
 */
export async function task(
  payload: { siteId: string } = { siteId: '' },
  jobId?: string
): Promise<TaskResult> {
  // -> A whole site's assets can take minutes, so the start IS worth saying — at `debug`, which is
  //    where an announcement belongs. The failure is not logged here: it propagates, and the
  //    scheduler writes the one record for it.
  WIKI.logger.debug('pages', 'exporting site content', { site: payload.siteId })
  const result = await WIKI.models.export.exportSite(payload.siteId)
  // -> The `{ filePath, fileSize }` on the history row is what the download route reads back, and
  //    stays a `setResult` write of its own; the summary returned below is only what this run's one
  //    `info` line says, and carries no path an operator could mistake for a public URL.
  if (jobId) {
    await WIKI.models.jobs.setResult(jobId, result)
  }
  return { summary: 'exported site content', site: payload.siteId, bytes: result.fileSize }
}
