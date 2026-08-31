import type { GraphPageRow } from '../models/pages.ts'
import type { PageHistoryContributorCounts } from '../models/pageHistory.ts'
import type { PageviewCountsForGraph } from '../models/pageviews.ts'

/**
 * Cache for the knowledge graph's assembled-but-permission-unfiltered data (OpenProject #2269) --
 * `api/graph.ts`'s three expensive per-request queries (`listAllForGraph`,
 * `contributorCountsForGraph`, `countsForGraph`) collapsed into one cached bundle per site. Caching
 * the raw bundle rather than the final per-caller response is deliberate: `GraphNode`/`GraphEdge`
 * visibility turns on the REQUESTING caller's own `read:pages` grants (`api/graph.ts`'s
 * `assembleGraph`), which differs caller to caller, while the underlying rows/counts this bundle
 * holds do not -- so one cached bundle per site serves every caller's own, freshly-filtered view.
 *
 * A helper module rather than living inside `api/graph.ts` itself: `models/pages.ts` and
 * `models/pageHistory.ts` both need to invalidate this on a write, and an api-layer module importing
 * those models back would invert the dependency direction the rest of the codebase keeps (api/ depends
 * on models/, never the reverse) -- the same reasoning that puts `helpers/pageRules.ts` below
 * `models/pages.ts` rather than the other way around. The three type imports above are `import
 * type`-only and erased at load time, so they carry no actual runtime dependency on those models.
 */
export interface GraphCacheData {
  rows: GraphPageRow[]
  contributorCounts: Map<string, PageHistoryContributorCounts>
  pageviewCounts: Map<string, PageviewCountsForGraph>
}

/**
 * How long an assembled graph bundle stays cached per site.
 *
 * Short, and mostly there to collapse a burst of near-simultaneous requests (several open tabs, a
 * dashboard auto-refresh) onto one rebuild rather than one each -- the explicit invalidation below is
 * what actually keeps a fresh edit from staying invisible, not this window.
 */
export const GRAPH_CACHE_TTL_MS = 60 * 1000

function graphCacheKey(siteId: string): string {
  return `graph:${siteId}`
}

/** The cached bundle for a site, or `undefined` on a cold cache. */
export function getCachedGraphData(siteId: string): GraphCacheData | undefined {
  return WIKI.cache.get(graphCacheKey(siteId)) as GraphCacheData | undefined
}

/** Cache an assembled bundle for a site, for `GRAPH_CACHE_TTL_MS`. */
export function setCachedGraphData(siteId: string, data: GraphCacheData): void {
  WIKI.cache.set(graphCacheKey(siteId), data, { ttl: GRAPH_CACHE_TTL_MS })
}

/**
 * Drop a site's cached graph bundle, so the next request rebuilds it.
 *
 * Called from every page create/update/move/delete and every `pageHistory.record()` -- anything that
 * can change the graph's nodes, edges or edit-volume contributor counts.
 *
 * Deliberately NOT called from `pageviews.record()`. A page view is logged on close to every page
 * read, so invalidating on each one would leave this cache cold under any real traffic, which defeats
 * the point of caching it at all. The visit-volume node sizing is left to `GRAPH_CACHE_TTL_MS` to stay
 * reasonably fresh instead -- a knowledge graph's node sizing tolerating up to a minute of staleness
 * on visit counts is the trade that makes "repeat callers never reach the database" actually hold once
 * real traffic is logging views continuously.
 */
export function invalidateGraphCache(siteId: string): void {
  WIKI.cache.delete(graphCacheKey(siteId))
}
