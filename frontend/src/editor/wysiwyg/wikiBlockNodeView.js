/**
 * The NodeView behind `wikiBlockNode.js`: mounts the actual `<block-name>` custom element as the
 * node's own DOM, so a block or a tabset is drawn in the WYSIWYG editor by the same code the read
 * view draws it with, rather than some editor-only stand-in -- the literal ask in OpenProject #3396's
 * owning WP ("a … block node view that renders the real custom element (`<block-*>`) inside the
 * editor").
 *
 * Plain ProseMirror NodeView, no Vue: there is nothing here a Vue component would do better. The
 * element itself IS the content -- `contentDOM` points straight at it, so ProseMirror manages its
 * children exactly as it would a paragraph's -- and the block's own component (Lit, for every
 * built-in) upgrades it and reads/paints from those very children as soon as its module loads.
 * `block-tabs`' shadow root reaches them through its own `<slot>`; `block-tab` (a plain
 * `HTMLElement`, no shadow root at all) and `block-infobox`/`block-checklist` (which read straight
 * off their own light DOM) need no slot to begin with. See the components under `blocks/` for why
 * each one already expects exactly this.
 */

/**
 * @param {{ loadBlock?: (tag: string) => void }} options The node's own `addOptions()` result -- see
 *   `wikiBlockNode.js`. `EditorWysiwyg.vue` supplies the real `loadBlock` (`loadBlock.js`); tests
 *   construct the view with none at all, or a stub that just records calls.
 * @returns {import('@tiptap/core').NodeViewRenderer}
 */
export function createWikiBlockNodeView(options = {}) {
  return ({ node: initialNode }) => {
    let node = initialNode
    const dom = document.createElement(`block-${node.attrs.block}`)
    dom.classList.add('wiki-block-node')
    applyBlockAttrs(dom, node.attrs.props)
    requestUpgrade(dom, options)

    return {
      dom,
      contentDOM: dom,
      ignoreMutation(mutation) {
        // -> A mutation inside the element's OWN shadow root (a Lit block re-painting itself, e.g.
        //    `block-countdown` ticking down, `block-tabs` switching which panel it shows) is that
        //    block's business, not ProseMirror's -- reacting to it would try to read editor content
        //    out of a subtree the schema never put there in the first place.
        return Boolean(dom.shadowRoot?.contains(mutation.target)) && mutation.target !== dom
      },
      update(updatedNode) {
        if (
          updatedNode.type.name !== node.type.name ||
          updatedNode.attrs.block !== node.attrs.block
        ) {
          // -> The tag itself changed -- only possible by hand-editing the node's attrs, never
          //    through the picker or the params form, since neither ever rewrites `block`. A
          //    NodeView cannot swap its own root element, so ask ProseMirror to tear this one down
          //    and build a fresh one against the new tag instead.
          return false
        }
        node = updatedNode
        applyBlockAttrs(dom, node.attrs.props)
        return true
      },
      destroy() {}
    }
  }
}

/**
 * Reconciles the element's own attributes with what the node currently holds -- everything the node
 * doesn't declare a prop for is removed (an author who cleared a field in the params form should
 * see that field's attribute actually go), `class` aside, which is this node view's own bookkeeping
 * rather than an MDC prop.
 *
 * @param {HTMLElement} dom
 * @param {Record<string, string|true>} [props]
 */
function applyBlockAttrs(dom, props = {}) {
  const wanted = new Set(Object.keys(props))
  // -> A snapshot, not a live `for…of` over `dom.attributes` itself: removing an attribute while
  //    iterating its own (live) NamedNodeMap reindexes it out from under the loop and silently
  //    skips whatever attribute would have come next.
  for (const attr of Array.from(dom.attributes)) {
    if (attr.name !== 'class' && !wanted.has(attr.name)) {
      dom.removeAttribute(attr.name)
    }
  }
  for (const [key, value] of Object.entries(props)) {
    dom.setAttribute(key, value === true ? '' : String(value))
  }
}

/**
 * Loads the block's own component the first time this tag shows up not yet upgraded -- the same
 * `:not(:defined)` question the read view's `collectBlocksToLoad` (`helpers/blockScan.js`) asks,
 * asked here once per NodeView mount instead of once per render over a whole subtree.
 *
 * @param {HTMLElement} dom
 * @param {{ loadBlock?: (tag: string) => void }} options
 */
function requestUpgrade(dom, options) {
  const tag = dom.tagName.toLowerCase()
  if (typeof options.loadBlock === 'function' && !window.customElements?.get(tag)) {
    options.loadBlock(tag)
  }
}
