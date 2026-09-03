/**
 * Every block a rendered page needs loaded before its custom elements can upgrade, scanned out of the
 * DOM subtree the render was written into.
 *
 * Pure over that subtree: it reads elements and the site's own public `blocksIndex`, and returns what
 * `commonStore.loadBlocks()` should be handed. Nothing is imported here -- the caller decides when.
 *
 * This is the READER-side scan. `EditorMarkdown.vue` keeps its own author-side copy for the editor's
 * live preview; the two mirror each other but are not identical, since the author's browser has the
 * (permission-gated) full block list this one deliberately does without.
 *
 * @param {Element|null|undefined} root The rendered content element, or nothing at all -- a locked
 *   page draws its lock screen in place of the article, so there is no content element to scan, and
 *   nothing in it to scan for.
 * @param {Record<string, {isCustom: boolean, id: string}>} blocksIndex `siteStore.blocksIndex`.
 * @returns {Array<string|{tag: string, isCustom: boolean, id: string}>} Entries in the shape
 *   `loadBlocks()` takes -- a bare tag for a built-in, the resolved record for a custom block.
 */
export function collectBlocksToLoad(root, blocksIndex) {
  // -> Collected by tag first, one `loadBlocks()` call after the loop, rather than one call
  //    per element -- matching the batched call `EditorMarkdown.vue`'s own preview render
  //    makes. A page can embed the same block tag many times (a gallery repeated three times
  //    down the page, say); the `Map` also dedupes those to one entry before `loadBlocks()`
  //    ever sees them.
  const toLoad = new Map()
  // -> Every enabled block's tag, computed once per scan rather than once per element -- what
  //    tells a still-parented child block (`block-tab` inside an enabled `block-tabs`) apart
  //    from an orphan or a disabled block below.
  const enabledBlockTags = Object.keys(blocksIndex).map((key) => `block-${key}`)
  for (const block of root?.querySelectorAll(':not(:defined)') ?? []) {
    const tag = block.tagName.toLowerCase()
    if (!tag.startsWith('block-')) {
      // -> Not a block tag at all -- an ordinary unknown custom element. Collected as a bare string
      //    anyway: it resolves nothing recognisable and the import 404s quietly, the same "preview
      //    being too generous is the better failure" trade `EditorMarkdown.vue`'s own
      //    `loadSiteBlocks()` documents for its own (author-gated) copy of this list.
      toLoad.set(tag, tag)
      continue
    }
    // -> Resolved off `siteStore.blocksIndex` (a public field on the site-info response
    //    every reader's browser already has) rather than `GET sites/:siteId/blocks`, which
    //    is gated to authors/administrators and silently 403s for a plain reader -- see
    //    `siteBlocksInfoFor` in `backend/api/sites.ts` (OpenProject #954).
    const record = blocksIndex[tag.slice('block-'.length)]
    if (record) {
      toLoad.set(tag, { tag, isCustom: record.isCustom, id: record.id })
      continue
    }
    /*
      Absent from `blocksIndex`. Most likely a disabled block -- `blockImportUrl()`
      (`stores/common.js`) resolves a bare tag to the flat, site-independent `/_blocks/<tag>.js`
      served unauthenticated by `fastifyStatic` (`backend/index.ts`), so falling back to it
      here the way the unknown-element branch above does would hand a reader a working URL to a
      block their site turned off -- exactly the leak `siteBlocksInfoFor`'s own doc says must
      never happen (OpenProject #1729).

      The one exception is a child block: `block-tab` gets no row of its own
      (`models/blocks.ts#syncSite`), so it never appears in `blocksIndex` even when its parent
      `block-tabs` is enabled. Told apart from a disabled block the same way the server already
      does: `unwrapOrphanedChildBlocks` (`backend/models/rendering.ts`) only ever lets a child
      tag reach the rendered HTML when its parent survived the enabled-blocks filter, so by the
      time this scan runs, an ancestor that resolves in `blocksIndex` is proof this element is
      still validly parented rather than orphaned.
    */
    if (enabledBlockTags.length > 0 && block.closest(enabledBlockTags.join(','))) {
      toLoad.set(tag, tag)
    }
  }
  return [...toLoad.values()]
}
