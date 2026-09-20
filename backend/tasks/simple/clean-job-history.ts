/**
 * Silent: `cleanHistory()` reports no count, and the scheduler already logs this job's finish and
 * writes the single record for a failure.
 */
export async function task(): Promise<void> {
  await CARDINAL.models.jobs.cleanHistory()
}
