/**
 * Site-level block config and import-URL resolution, for blocks.
 *
 * An admin sets a field like a tile server URL once for the whole site, in a block's admin config —
 * see `config` on a block's `static definition`, alongside `props`, which an author sets per use in
 * the editor instead. A reader's page must never call `GET /sites/:siteId/blocks` to get at either
 * this or a custom block's id: that route is gated to authors and administrators (`mayListBlocks` in
 * `backend/api/blocks.ts`), which a plain reader is neither.
 *
 * So both read off the public site-info response instead — `GET /_api/sites/current`, the same
 * hostname-based site routing the frontend already resolves `current` through — which carries a
 * `blocksConfig` map keyed by block tag and a `blocksIndex` map of `{ id, isCustom }` per enabled
 * block (`siteBlocksInfoFor` in `backend/api/sites.ts`). A relative fetch is enough: it resolves
 * against whatever hostname the page is actually being read on, so no site ID needs to be threaded
 * down from the frontend to reach a block sitting in page content.
 *
 * Fetched once per page load and cached, the same pattern as `fetchIcon` in `./icons.js`: the whole
 * payload in one request, not one request per block instance, so a page with several maps -- or a
 * transcluded page with several custom blocks in it (`block-include`'s `_loadNestedBlocks`) -- still
 * only asks once. That cache is `./site.js`'s `fetchSite()`, which this module imports rather than
 * keeping a second one of its own over the identical request (BLK-F5): a page with a map and a
 * checklist on it used to ask for the same payload twice, and needed two test-reset hooks to
 * forget it.
 */

import { fetchSite } from './site.js'

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
  const site = await fetchSite()
  return site?.blocksConfig?.[tag] ?? {}
}

/**
 * Where a custom or built-in block's compiled component lives, for the dynamic `import()` a reader's
 * page runs to upgrade an undefined `block-*` element.
 *
 * Resolved off `blocksIndex` (see file header) rather than the tag alone: a built-in's compiled
 * output is a flat file under `blocks/compiled`, served by the static `/_blocks/` mount and addressed
 * by its tag on every site, but a custom block has no such file -- its code is a per-site row, served
 * by `/_blocks/custom/:siteId/:id.js` (`controllers/blocks.ts`), which needs the site and the block's
 * own id rather than just its tag. Mirrors `blockImportUrl()` in `frontend/src/stores/common.js`,
 * which resolves the same URL for the app's own page view — this is the `blocks/` workspace's
 * equivalent for a block that has to resolve it for itself (a nested block inside transcluded
 * content, loaded after the page view's own scan already ran).
 *
 * Falls back to the flat, tag-only URL for anything `blocksIndex` doesn't have an entry for --
 * disabled, or not a real block at all -- the same "preview being too generous is the better
 * failure" trade `getBlockConfig` above makes for a missing config.
 *
 * @param {string} elementTag The element's tag name, e.g. `block-map`.
 * @returns {Promise<string>}
 */
export async function getBlockImportUrl(elementTag) {
  const site = await fetchSite()
  const tag = elementTag.replace(/^block-/, '')
  const record = site?.blocksIndex?.[tag]
  if (record?.isCustom && site?.id) {
    return `/_blocks/custom/${site.id}/${record.id}.js`
  }
  return `/_blocks/${elementTag}.js`
}
