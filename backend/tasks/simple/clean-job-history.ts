/**
 * Trim `jobHistory` to the scheduler's retention window.
 *
 * Silent: `cleanHistory()` reports no count, so there is nothing to say that the scheduler's own
 * `debug jobs cleanJobHistory finished` line does not already say, and a failure reaches the log as
 * the scheduler's single failure record rather than as a second one from here.
 */
export async function task(): Promise<void> {
  await WIKI.models.jobs.cleanHistory()
}
