import type { TaskResult } from '../../core/scheduler.ts'

/**
 * Queued from `POST /_api/system/export` rather than run inline: a whole site's worth of asset bytes
 * is not something a request thread should be blocked on. `jobId` is this task's own `jobHistory`
 * row, and recording the result on it is what lets `GET /_api/system/export/:jobId/download` find
 * the finished file.
 */
export async function task(
  payload: { siteId: string } = { siteId: '' },
  jobId?: string
): Promise<TaskResult> {
  // -> Announced at `debug` because a whole site's assets can take minutes. The failure propagates
  //    instead of being logged, so the scheduler writes the one record for it.
  CARDINAL.logger.debug('pages', 'exporting site content', { site: payload.siteId })
  const result = await CARDINAL.models.export.exportSite(payload.siteId)
  // -> The history row carries `{ filePath, fileSize }` for the download route; the returned summary
  //    becomes a log line, so it carries no path an operator could mistake for a public URL.
  if (jobId) {
    await CARDINAL.models.jobs.setResult(jobId, result)
  }
  return { summary: 'exported site content', site: payload.siteId, bytes: result.fileSize }
}
