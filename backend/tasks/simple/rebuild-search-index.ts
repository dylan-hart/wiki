/**
 * Recompute the search vector of every page of one site.
 *
 * Queued from the admin area's per-site search view (`POST /sites/:siteId/search/rebuild`), and safe
 * to run at any time: it only rewrites `pages.ts` from the content already stored on each page.
 *
 * Scoped to the `siteId` carried in the job's payload rather than looping over every site: search
 * configuration (`site.config.search`) is per-site since task #563, so an operator with several sites
 * rebuilds the one whose settings just changed, the same way `WIKI.models.search.rebuild(siteId)`
 * itself is already scoped.
 */
export async function task(payload: { siteId: string }): Promise<void> {
  await WIKI.models.search.rebuild(payload.siteId)
}
