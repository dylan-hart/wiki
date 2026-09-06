export async function task(): Promise<void> {
  const queued = await WIKI.models.storage.tickScheduledSyncs()
  // -> Runs on a short interval and finds nothing almost every time, so the idle case is `debug` and
  //    only a tick that actually queued work is worth an operator's `info` log (audit X1/X2).
  if (queued > 0) {
    WIKI.logger.info('storage', 'queued scheduled syncs', { queued })
  } else {
    WIKI.logger.debug('storage', 'no storage sync was due')
  }
}
