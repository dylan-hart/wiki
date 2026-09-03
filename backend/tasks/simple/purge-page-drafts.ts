export async function task(): Promise<void> {
  WIKI.logger.info('Purging stale page drafts...')

  try {
    const purged = await WIKI.models.pageDrafts.purgeStale()

    WIKI.logger.info(`Purged ${purged} stale page drafts: [ COMPLETED ]`)
  } catch (err: any) {
    WIKI.logger.error('Purging stale page drafts: [ FAILED ]')
    WIKI.logger.error(err.message)
    throw err
  }
}
