import type { GraphPageRow } from './pages.ts'
import type { PageHistoryContributorCounts } from './pageHistory.ts'
import type { PageviewCountsForGraph } from './pageviews.ts'

/**
 * Cache for `GET /sites/:siteId/graph`'s three aggregate queries (OpenProject #2269) --
 * `pages.listAllForGraph`, `pageHistory.contributorCountsForGraph` and `pageviews.countsForGraph` --
 * kept apart from `api/graph.ts` so the write paths that need to invalidate it
 * (`pageHistory.record()`, `pageviews.record()`) can reach it through `WIKI.models.graph`, the same
 * cross-model convention `pages.ts` already uses for `WIKI.models.glossary.invalidateCache()`,
 * rather than an import cycle back into the API layer.
 *
 * What is cached is the raw, PRE-PERMISSION material -- never the assembled, permission-filtered
 * `Graph` itself. `assembleGraph`'s `canRead` predicate is what applies `read:pages` per requester,
 * and that has to run fresh on every request: caching its output would mean the first requester
 * after a cold rebuild decides what every other requester (with different page-rule grants) sees
 * until the entry expires or is invalidated.
 */
export interface CachedGraphData {
  rows: GraphPageRow[]
  contributorCounts: Map<string, PageHistoryContributorCounts>
  pageviewCounts: Map<string, PageviewCountsForGraph>
}

/** Short: this is a cache the write paths above also invalidate directly, so the TTL is only the
 *  backstop for a write this instance didn't see coming (a direct DB change, another process). */
const CACHE_TTL_MS = 60_000

function cacheKey(siteId: string): string {
  return `graph:${siteId}`
}

class GraphCache {
  /** The cached pre-permission data for a site, or `undefined` on a cold cache. */
  get(siteId: string): CachedGraphData | undefined {
    return WIKI.cache.get(cacheKey(siteId)) as CachedGraphData | undefined
  }

  set(siteId: string, data: CachedGraphData): void {
    WIKI.cache.set(cacheKey(siteId), data, { ttl: CACHE_TTL_MS })
  }

  /** Drops a site's cached graph data -- called by every write path that changes what the graph's
   *  three aggregate queries would return: `pageHistory.record()` (page structure -- title, icon,
   *  tags, classification, relations, links -- and edit-volume counts change together on every
   *  recorded version) and `pageviews.record()` (visit-volume counts). */
  invalidate(siteId: string): void {
    WIKI.cache.delete(cacheKey(siteId))
  }
}

export const graph = new GraphCache()
