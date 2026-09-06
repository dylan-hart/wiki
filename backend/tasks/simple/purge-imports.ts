import type { TaskResult } from '../../core/scheduler.ts'

/**
 * Sweep `<dataPath>/imports/` of uploads whose job never ran to completion to clean up after itself.
 *
 * `importContent` deletes its own upload once it finishes, success or failure alike, so this only
 * ever finds one left behind by a crash mid-import — still cheap to run daily. Mirrors `purgeExports`.
 */
export async function task(): Promise<TaskResult | void> {
  const count = await WIKI.models.import.purgeExpired()
  if (count > 0) {
    return { summary: 'purged abandoned content import uploads', purged: count }
  }
}
