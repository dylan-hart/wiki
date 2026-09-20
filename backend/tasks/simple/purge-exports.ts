import type { TaskResult } from '../../core/scheduler.ts'

/**
 * A successful download deletes its own tarball, so this only ever finds ones that were queued and
 * abandoned — cheap enough to run daily regardless.
 */
export async function task(): Promise<TaskResult | void> {
  const count = await CARDINAL.models.export.purgeExpired()
  if (count > 0) {
    return { summary: 'purged expired content exports', purged: count }
  }
}
