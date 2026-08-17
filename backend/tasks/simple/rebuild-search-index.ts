/**
 * Recompute the search vector of every page, on every site.
 *
 * Queued from the admin area's search view, and safe to run at any time: it only rewrites `pages.ts`
 * from the content already stored on each page.
 *
 * `WIKI.models.search.rebuild` is per-site — the `SearchModule` interface takes a `siteId`, the same
 * way `query` does, so that a site on a different engine rebuilds against its own — so this loops over
 * every site rather than issuing one instance-wide rebuild.
 */
export async function task(): Promise<void> {
  const sites = await WIKI.models.sites.getAllSites()
  for (const site of sites) {
    await WIKI.models.search.rebuild(site.id)
  }
}
