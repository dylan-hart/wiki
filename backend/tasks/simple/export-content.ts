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
): Promise<void> {
  WIKI.logger.info(`Exporting content for site ${payload.siteId}...`)
  try {
    const result = await WIKI.models.export.exportSite(payload.siteId)
    if (jobId) {
      await WIKI.models.jobs.setResult(jobId, result)
    }
    WIKI.logger.info(`Exported content for site ${payload.siteId}: [ COMPLETED ]`)
  } catch (err: any) {
    WIKI.logger.error(`Exporting content for site ${payload.siteId}: [ FAILED ]`)
    WIKI.logger.error(err.message)
    throw err
  }
}
