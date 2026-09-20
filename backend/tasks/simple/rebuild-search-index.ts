/**
 * Safe to run at any time: it only recomputes search vectors from the content already stored on each
 * page. Scoped to one site rather than looping over every site because search configuration
 * (`site.config.search`) is per-site, so an operator rebuilds the one whose settings just changed.
 */
export async function task(payload: { siteId: string }): Promise<void> {
  await CARDINAL.models.search.rebuild(payload.siteId)
}
