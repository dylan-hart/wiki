/**
 * Restore a tarball uploaded through `POST /_api/system/import` into a target site.
 *
 * Queued from the route rather than run inline, mirroring `exportContent`: reading a whole archive
 * back apart and restoring it inside a transaction is not something a request thread should be
 * blocked on. The uploaded file is a working file rather than a downloadable product (unlike an
 * export's tarball), so it is deleted once this task is done with it — success or failure alike.
 */
export async function task(
  payload: { filePath: string; targetSiteId: string; importedById: string } = {
    filePath: '',
    targetSiteId: '',
    importedById: ''
  },
  jobId?: string
): Promise<void> {
  WIKI.logger.info(`Importing content into site ${payload.targetSiteId}...`)
  try {
    const result = await WIKI.models.import.importSite(
      payload.filePath,
      payload.targetSiteId,
      payload.importedById
    )
    if (jobId) {
      await WIKI.models.jobs.setResult(jobId, result)
    }
    WIKI.logger.info(`Imported content into site ${payload.targetSiteId}: [ COMPLETED ]`)
  } catch (err: any) {
    WIKI.logger.error(`Importing content into site ${payload.targetSiteId}: [ FAILED ]`)
    WIKI.logger.error(err.message)
    throw err
  } finally {
    await WIKI.models.import.deleteUpload(payload.filePath)
  }
}
