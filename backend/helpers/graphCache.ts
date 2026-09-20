import type { GraphPageRow } from '../models/pages.ts'
import type { PageHistoryContributorCounts } from '../models/pageHistory.ts'
import type { PageviewCountsForGraph } from '../models/pageviews.ts'

/**
 * The knowledge graph's per-site data, cached BEFORE permission filtering: node and edge visibility
 * turns on the requesting caller's own `read:pages` grants (`api/graph.ts#assembleGraph`), while
 * the underlying rows and counts do not, so one bundle serves every caller's freshly-filtered view.
 *
 * A helper rather than part of `api/graph.ts` because the page and page-history models invalidate
 * it on a write, and a model importing from `api/` would invert the dependency direction.
 */
export interface GraphCacheData {
  rows: GraphPageRow[]
  contributorCounts: Map<string, PageHistoryContributorCounts>
  pageviewCounts: Map<string, PageviewCountsForGraph>
}

/**
 * Short: it collapses a burst of near-simultaneous requests onto one rebuild. Explicit
 * invalidation, not this window, is what keeps a fresh edit visible.
 */
export const GRAPH_CACHE_TTL_MS = 60 * 1000

function graphCacheKey(siteId: string): string {
  return `graph:${siteId}`
}

export function getCachedGraphData(siteId: string): GraphCacheData | undefined {
  return CARDINAL.cache.get(graphCacheKey(siteId)) as GraphCacheData | undefined
}

export function setCachedGraphData(siteId: string, data: GraphCacheData): void {
  CARDINAL.cache.set(graphCacheKey(siteId), data, { ttl: GRAPH_CACHE_TTL_MS })
}

/**
 * For anything that changes the graph's nodes, edges or contributor counts. Deliberately NOT called
 * when a page view is recorded: that happens on nearly every page read and would keep the cache
 * permanently cold, so visit-count node sizing is left to go stale for up to `GRAPH_CACHE_TTL_MS`.
 */
export function invalidateGraphCache(siteId: string): void {
  CARDINAL.cache.delete(graphCacheKey(siteId))
}
