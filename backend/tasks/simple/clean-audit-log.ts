export async function task(): Promise<void> {
  WIKI.logger.info('Cleaning audit log...')

  try {
    await WIKI.models.auditLog.purge(WIKI.models.auditLog.getRetentionDays())

    WIKI.logger.info('Cleaning audit log: [ COMPLETED ]')
  } catch (err: any) {
    WIKI.logger.error('Cleaning audit log: [ FAILED ]')
    WIKI.logger.error(err.message)
    throw err
  }
}
