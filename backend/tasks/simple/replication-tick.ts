export async function task(): Promise<void> {
  WIKI.logger.info('Checking replication schedule for a due pull...')

  try {
    const queued = await WIKI.models.replication.tick()

    WIKI.logger.info(`Checked replication schedule, queued ${queued} pull(s): [ COMPLETED ]`)
  } catch (err: any) {
    WIKI.logger.error('Checking replication schedule: [ FAILED ]')
    WIKI.logger.error(err.message)
    throw err
  }
}
