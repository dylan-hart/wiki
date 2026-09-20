import type { TaskResult } from '../../core/scheduler.ts'

/**
 * `importContent` deletes its own upload when it finishes, success or failure alike, so this only
 * ever finds one left behind by a crash mid-import — cheap enough to run daily regardless.
 */
export async function task(): Promise<TaskResult | void> {
  const count = await CARDINAL.models.import.purgeExpired()
  if (count > 0) {
    return { summary: 'purged abandoned content import uploads', purged: count }
  }
}
