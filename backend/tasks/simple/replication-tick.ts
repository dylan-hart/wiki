export async function task(): Promise<void> {
  const queued = await WIKI.models.replication.tick()
  // -> Same shape as `storage-sync-tick.ts`: idle is the common case, every few minutes.
  if (queued > 0) {
    WIKI.logger.info('storage', 'queued replication pulls', { queued })
  } else {
    WIKI.logger.debug('storage', 'no replication pull was due')
  }
}
