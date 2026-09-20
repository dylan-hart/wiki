/**
 * Resolving a `block-*` tag off the site's own `blocksIndex` is what lets
 * `commonStore.loadBlocks()` tell a custom block's per-site import URL from a built-in's flat one.
 * A tag matching nothing there -- an unknown element, or the index not loaded yet -- is passed as
 * the bare string, which `loadBlocks()` treats as a built-in guess: a deliberately generous preview
 * rather than a silent blank.
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
