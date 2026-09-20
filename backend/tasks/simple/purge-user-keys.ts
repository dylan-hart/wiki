import type { TaskResult } from '../../core/scheduler.ts'

/**
 * A `userKeys` row otherwise only goes when consumed, destroyed, or when its user is deleted, so a
 * token generated and never presented — an abandoned password-reset link, an abandoned 2FA
 * continuation — would accumulate forever.
 */
export async function task(): Promise<TaskResult | void> {
  const count = await CARDINAL.models.userCredentials.purgeExpiredKeys()
  if (count > 0) {
    return { summary: 'purged expired user keys', purged: count }
  }
}
