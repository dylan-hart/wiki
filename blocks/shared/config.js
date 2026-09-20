/**
 * A reader's page cannot call `GET /sites/:siteId/blocks` for a block's site config or its id: that
 * route is gated to authors and administrators (`mayListBlocks` in `backend/api/blocks.ts`). Both
 * come off the public site-info response instead — `GET /_api/sites/current`, carrying
 * `blocksConfig` and `blocksIndex` (`siteBlocksInfoFor` in `backend/api/sites.ts`) — which is
 * hostname-routed, so a relative fetch reaches the right site with no site ID threaded down to a
 * block sitting in page content.
 */

import { fetchSite } from './site.js'

/**
 * Empty for an unconfigured block, a disabled one and a failed fetch alike: a missing config means
 * the block falls back to its own defaults rather than breaking.
 *
 * @param {string} tag A block's `block` key, e.g. `map`.
 * @returns {Promise<Record<string, any>>}
 */
export async function getBlockConfig(tag) {
  const site = await fetchSite()
  return site?.blocksConfig?.[tag] ?? {}
}

/**
 * Resolved off `blocksIndex` rather than the tag alone: a built-in's compiled output is a flat file
 * under the static `/_blocks/` mount, addressed by tag on every site, but a custom block has no such
 * file -- its code is a per-site row served by `/_blocks/custom/:siteId/:id.js`
 * (`controllers/blocks.ts`), which needs the site and the block's own id. Anything `blocksIndex` has
 * no entry for -- disabled, or not a block at all -- falls back to the flat URL, erring towards a
 * failed import over refusing to try. Mirrors `blockImportUrl()` in `frontend/src/stores/common.js`.
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
