/**
 * Every block a rendered page needs loaded before its custom elements can upgrade. Returns what
 * `commonStore.loadBlocks()` should be handed; nothing is imported here -- the caller decides when.
 *
 * This is the READER-side scan. `EditorMarkdown.vue` keeps its own author-side copy for the editor's
 * live preview; the two mirror each other but are not identical, since the author's browser has the
 * (permission-gated) full block list this one deliberately does without.
 *
 * `root` is absent for a locked page, which draws its lock screen in place of the article.
 */
export function collectBlocksToLoad(root, blocksIndex) {
  // -> Keyed by tag so one `loadBlocks()` call covers the page: a page can embed the same block tag
  //    many times, and the `Map` dedupes those before `loadBlocks()` sees them
  const toLoad = new Map()
  // -> Computed once per scan: what tells a still-parented child block (`block-tab` inside an
  //    enabled `block-tabs`) apart from an orphan or a disabled block below
  const enabledBlockTags = Object.keys(blocksIndex).map((key) => `block-${key}`)
  for (const block of root?.querySelectorAll(':not(:defined)') ?? []) {
    const tag = block.tagName.toLowerCase()
    if (!tag.startsWith('block-')) {
      // -> An ordinary unknown custom element, collected anyway: it resolves nothing recognisable
      //    and the import 404s quietly, being too generous here the better failure
      toLoad.set(tag, tag)
      continue
    }
    // -> Resolved off `siteStore.blocksIndex`, a public field every reader's browser already has,
    //    rather than `GET sites/:siteId/blocks`, which is gated and silently 403s for a plain reader
    const record = blocksIndex[tag.slice('block-'.length)]
    if (record) {
      toLoad.set(tag, { tag, isCustom: record.isCustom, id: record.id })
      continue
    }
    /*
      Absent from `blocksIndex`, so most likely a disabled block. Falling back to a bare tag the way
      the unknown-element branch above does would leak it: `blockImportUrl()` (`stores/common.js`)
      resolves a bare tag to the site-independent `/_blocks/<tag>.js`, served unauthenticated, which
      would hand a reader a working URL to a block their site turned off.

      The exception is a child block: `block-tab` has no row of its own, so it never appears in
      `blocksIndex` even when its parent `block-tabs` is enabled. The server's
      `unwrapOrphanedChildBlocks` only lets a child tag reach the rendered HTML when its parent
      survived the enabled-blocks filter, so an ancestor that resolves here is proof of parentage.
    */
    if (enabledBlockTags.length > 0 && block.closest(enabledBlockTags.join(','))) {
      toLoad.set(tag, tag)
    }
  }
  return [...toLoad.values()]
}
