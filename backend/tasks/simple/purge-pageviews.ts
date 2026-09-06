/**
 * Sweep `pageviews` rows older than the 2-year retention window (OpenProject #1238) -- the same span
 * as the knowledge graph's longest trailing window (#1140), so "all-time" and "2 years" are the same
 * query once this has run. Mirrors `purge-rate-limits.ts`'s shape: a single model call, logged only
 * when it actually removed something.
 */
export async function task(): Promise<void> {
  const count = await WIKI.models.pageviews.purgeExpired()
  if (count > 0) {
    WIKI.logger.info('pages', 'purged pageviews past the retention window', { purged: count })
  }
}
