/**
 * Per-site cache for `/sitemap.xml`'s rendered body (OpenProject #2267).
 *
 * `GET /sitemap.xml` (`controllers/seo.ts`) used to run `listPagesForSitemap` — every published,
 * browsable row for the site, each checked against the guests group's page rules in JS, with no
 * LIMIT — on every single request, with nothing cached and no `Cache-Control` set. This gives that
 * request a per-site cache with a TTL of a few minutes, so repeated crawler/monitoring hits inside
 * the window cost nothing beyond a cache read.
 *
 * Lives in `helpers/` rather than inside `controllers/seo.ts` or `models/pages.ts`: the controller
 * reads and writes the cached body on every request, while `models/pages.ts` has to drop a site's
 * entry whenever a write could change what the sitemap ought to say (create, publish/update, move,
 * delete). CLAUDE.md's own layering has controllers depend on models, never the reverse, so a
 * primitive both sides need sits in `helpers/` instead — the same reason `helpers/pageRules.ts` and
 * `helpers/siteRules.ts` are their own modules rather than living inside one particular model.
 *
 * The cached value carries the `baseUrl` it was rendered for alongside the body: a site reached
 * through more than one hostname (the catch-all `*` site, most notably — see `models/sites.ts`'s
 * `getSiteByHostname`) can have requests for the *same* `siteId` arrive with different
 * `${protocol}://${hostname}` values, and a `<loc>` baked for one hostname would be wrong served to
 * another. A mismatched `baseUrl` is therefore treated as a cache miss rather than served anyway.
 */

/** How long a rendered sitemap body is served from cache before being recomputed. */
export const SITEMAP_CACHE_TTL_MS = 5 * 60 * 1000

interface CachedSitemap {
  baseUrl: string
  body: string
}

function cacheKey(siteId: string): string {
  return `sitemap:${siteId}`
}

/** The cached body for this site, or `undefined` on a miss — including a `baseUrl` mismatch. */
export function getCachedSitemap(siteId: string, baseUrl: string): string | undefined {
  const cached = WIKI.cache.get(cacheKey(siteId)) as CachedSitemap | undefined
  return cached && cached.baseUrl === baseUrl ? cached.body : undefined
}

/** Caches a freshly rendered body for `baseUrl`, for `SITEMAP_CACHE_TTL_MS`. */
export function setCachedSitemap(siteId: string, baseUrl: string, body: string): void {
  WIKI.cache.set(cacheKey(siteId), { baseUrl, body }, { ttl: SITEMAP_CACHE_TTL_MS })
}

/**
 * Drops a site's cached sitemap body. Called from `models/pages.ts` on any write that could change
 * what the sitemap should say — create, update, move, delete — since the cached body itself doesn't
 * know which of its rows a given write touched.
 */
export function invalidateSitemapCache(siteId: string): void {
  WIKI.cache.delete(cacheKey(siteId))
}
