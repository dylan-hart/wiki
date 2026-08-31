export async function task(): Promise<void> {
  WIKI.logger.info('Purging guest comment PII...')

  try {
    await WIKI.models.comments.purgeGuestPii(WIKI.models.comments.getGuestPiiRetentionDays())

    WIKI.logger.info('Purging guest comment PII: [ COMPLETED ]')
  } catch (err: any) {
    WIKI.logger.error('Purging guest comment PII: [ FAILED ]')
    WIKI.logger.error(err.message)
    throw err
  }
}
