export async function task(): Promise<void> {
  WIKI.logger.info('Checking storage targets for a due scheduled sync...')

  try {
    const queued = await WIKI.models.storage.tickScheduledSyncs()

    WIKI.logger.info(`Checked storage sync schedule, queued ${queued} sync(s): [ COMPLETED ]`)
  } catch (err: any) {
    WIKI.logger.error('Checking storage sync schedule: [ FAILED ]')
    WIKI.logger.error(err.message)
    throw err
  }
}
