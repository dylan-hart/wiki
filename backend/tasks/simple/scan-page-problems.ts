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
  // -> Announced at `debug` because a full scan of `pages` and `tree` is not instant on a large
  //    wiki; the five counts are fields on the outcome line rather than a sentence built from them.
  WIKI.logger.debug('pages', 'scanning for page problems')
  const report = await WIKI.models.pageProblems.scan()
  if (jobId) {
    await WIKI.models.jobs.setResult(jobId, report as unknown as Record<string, any>)
  }
  WIKI.logger.info('pages', 'scanned for page problems', {
    hashDrift: report.hashDrift.count,
    treeDivergence: report.treeDivergence.count,
    duplicatePaths: report.duplicatePaths.count,
    localeCollisions: report.localeCollisions.count,
    brokenRelations: report.brokenRelations.count
  })
}
