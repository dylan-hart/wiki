/**
 * Run the five page/tree integrity checks (see `models/pageProblems.ts`) and record the report on the
 * job's own history row.
 *
 * Queued from `POST /_api/system/pages/scan` rather than run inline: a full scan of `pages` and
 * `tree` on a large wiki is not instant. `jobId` is this task's own row in `jobHistory` (see
 * `core/scheduler.ts`'s `SimpleTask`) — recording the result on it is what lets
 * `GET /_api/system/pages/scan/:jobId` poll for it.
 */
export async function task(_payload: unknown = {}, jobId?: string): Promise<void> {
  WIKI.logger.info('Scanning for page problems...')
  try {
    const report = await WIKI.models.pageProblems.scan()
    if (jobId) {
      await WIKI.models.jobs.setResult(jobId, report as unknown as Record<string, any>)
    }
    WIKI.logger.info(
      `Scanning for page problems: [ COMPLETED ] ` +
        `${report.hashDrift.count} hash drift, ` +
        `${report.treeDivergence.count} tree divergence, ` +
        `${report.duplicatePaths.count} duplicate paths, ` +
        `${report.localeCollisions.count} locale-code collisions, ` +
        `${report.brokenRelations.count} broken relations`
    )
  } catch (err: any) {
    WIKI.logger.error('Scanning for page problems: [ FAILED ]')
    WIKI.logger.error(err.message)
    throw err
  }
}
