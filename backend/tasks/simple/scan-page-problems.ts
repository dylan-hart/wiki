import type { TaskResult } from '../../core/scheduler.ts'

export async function task(_payload: unknown = {}, jobId?: string): Promise<TaskResult> {
  CARDINAL.logger.debug('pages', 'scanning for page problems')
  const report = await CARDINAL.models.pageProblems.scan()
  // -> The full report goes on this task's own `jobHistory` row, which is what
  //    `GET /_api/system/pages/scan/:jobId` polls; the returned counts are the scheduler's `info`
  //    line instead.
  if (jobId) {
    await CARDINAL.models.jobs.setResult(jobId, report as unknown as Record<string, any>)
  }
  return {
    summary: 'scanned for page problems',
    hashDrift: report.hashDrift.count,
    treeDivergence: report.treeDivergence.count,
    duplicatePaths: report.duplicatePaths.count,
    localeCollisions: report.localeCollisions.count,
    brokenRelations: report.brokenRelations.count
  }
}
