/**
 * Site-level block config, for blocks.
 *
 * An admin sets a field like a tile server URL once for the whole site, in a block's admin config —
 * see `config` on a block's `static definition`, alongside `props`, which an author sets per use in
 * the editor instead. A reader's page must never call `GET /sites/:siteId/blocks` to get at it: that
 * route is gated to authors and administrators (`mayListBlocks` in `backend/api/blocks.ts`), which a
 * plain reader is neither.
 *
 * So this reads it off the public site-info response instead — `GET /_api/sites/current`, the same
 * hostname-based site routing the frontend already resolves `current` through — which now carries a
 * `blocksConfig` map keyed by block tag (`blocksConfigFor` in `backend/api/sites.ts`). A relative
 * fetch is enough: it resolves against whatever hostname the page is actually being read on, so no
 * site ID needs to be threaded down from the frontend to reach a block sitting in page content.
 *
 * Fetched once per page load and cached, the same pattern as `fetchIcon` in `./icons.js`: the whole
 * map in one request, not one request per block instance, so a page with several maps on it still
 * only asks once.
 */

/** The site's block config map, once fetched. Holds the promise, so concurrent callers share one request. */
let configPromise = null

/**
 * The site-level config for one block tag.
 *
 * An empty object for a block with nothing configured, one that is disabled, or a request that
 * failed — a missing config is a block falling back to its own defaults, not a block that breaks.
 *
 * @param {string} tag A block's `block` key, e.g. `map`.
 * @returns {Promise<Record<string, any>>}
 */
export async function getBlockConfig(tag) {
  if (!configPromise) {
    configPromise = fetch('/_api/sites/current')
      .then((resp) => (resp.ok ? resp.json() : null))
      .then((site) => site?.blocksConfig ?? {})
      .catch(() => ({}))
  }
  const blocksConfig = await configPromise
  return blocksConfig[tag] ?? {}
}

/**
 * Test-only: forgets the cached fetch, so a new `getBlockConfig` call issues a fresh request.
 *
 * The module-level cache is deliberate in production (see above) but would otherwise leak the first
 * test's mocked response into every test that runs after it in the same file.
 */
export function _resetBlockConfigCache() {
  configPromise = null
}
