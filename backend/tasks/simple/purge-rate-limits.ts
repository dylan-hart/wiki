export async function task(): Promise<void> {
  const purged = await WIKI.models.rateLimits.purgeStale()
  if (purged > 0) {
    WIKI.logger.info('auth', 'purged stale rate limit counters', { purged })
  }
}
