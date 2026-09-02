/**
 * Sweep `userKeys` rows past their `validUntil` (OpenProject #1684) -- a row otherwise only goes when
 * consumed, destroyed, or when its user is deleted, so a token generated and never presented (an
 * abandoned password-reset link, an abandoned 2FA continuation) would otherwise accumulate forever.
 * Mirrors `purge-pageviews.ts`'s shape: a single model call, logged only when it actually removed
 * something.
 */
export async function task(): Promise<void> {
  const count = await WIKI.models.userCredentials.purgeExpiredKeys()
  if (count > 0) {
    WIKI.logger.info(`Purged ${count} expired user key(s).`)
  }
}
