/**
 * `WikiBlock`'s `loadBlock` option (`wikiBlockNode.js`), wired up with the real stores.
 *
 * Resolves a `block-*` tag the same way the read view's own scan does
 * (`helpers/blockScan.js#collectBlocksToLoad`): off the site's own public `blocksIndex` when the tag
 * matches a block this site has, which is what lets `commonStore.loadBlocks()` tell a custom block's
 * per-site import URL from a built-in's flat one. A tag matching nothing there (an unknown element,
 * a block not yet reflected in `blocksIndex`, or the reader-side list not having loaded) is passed
 * as the bare string, which `loadBlocks()` treats as a built-in guess -- the same generous-preview
 * fallback `EditorMarkdown.vue`'s own `loadSiteBlocks()` documents for its author-side copy of this.
 *
 * @param {import('@/stores/common').useCommonStore extends () => infer S ? S : never} commonStore
 * @param {import('@/stores/site').useSiteStore extends () => infer S ? S : never} siteStore
 * @returns {(tag: string) => void}
 */
export function createBlockLoader(commonStore, siteStore) {
  return (tag) => {
    const name = tag.startsWith('block-') ? tag.slice('block-'.length) : tag
    const record = siteStore.blocksIndex[name]
    const entry = record ? { tag, isCustom: record.isCustom, id: record.id } : tag
    commonStore.loadBlocks([entry])
  }
}
