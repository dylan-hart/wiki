export async function task(): Promise<void> {
  const purged = await WIKI.models.comments.purgeGuestPii(
    WIKI.models.comments.getGuestPiiRetentionDays()
  )
  if (purged > 0) {
    WIKI.logger.info('pages', 'purged guest comment PII past the retention window', { purged })
  }
}
