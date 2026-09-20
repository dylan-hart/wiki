/**
 * Mounts the real `<block-name>` custom element as the node's own DOM, so the WYSIWYG editor draws
 * a block with the same code the read view draws it with rather than an editor-only stand-in.
 *
 * Plain ProseMirror, no Vue: the element itself IS the content -- `contentDOM` points straight at
 * it, so ProseMirror manages its children exactly as it would a paragraph's, and the block's own
 * component upgrades it and paints from those very children as soon as its module loads.
 */

/**
 * @param {{ loadBlock?: (tag: string) => void }} options The node's own `addOptions()` result.
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
        // -> A mutation inside the element's OWN shadow root is the block re-painting itself, not
        //    ProseMirror's business: reacting would read editor content out of a subtree the schema
        //    never put there.
        return Boolean(dom.shadowRoot?.contains(mutation.target)) && mutation.target !== dom
      },
      update(updatedNode) {
        if (
          updatedNode.type.name !== node.type.name ||
          updatedNode.attrs.block !== node.attrs.block
        ) {
          // -> The tag changed, and a NodeView cannot swap its own root element: `false` asks
          //    ProseMirror to tear this one down and build a fresh one against the new tag.
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
 * An attribute the node holds no prop for is removed, so a field an author cleared in the params
 * form actually disappears. `class` is exempt: it is this node view's own bookkeeping, not a prop.
 *
 * @param {Record<string, string|true>} [props]
 */
function applyBlockAttrs(dom, props = {}) {
  const wanted = new Set(Object.keys(props))
  // -> A snapshot, not the live NamedNodeMap: removing an attribute while iterating `dom.attributes`
  //    reindexes it under the loop and silently skips whatever came next.
  for (const attr of Array.from(dom.attributes)) {
    if (attr.name !== 'class' && !wanted.has(attr.name)) {
      dom.removeAttribute(attr.name)
    }
  }
  for (const [key, value] of Object.entries(props)) {
    dom.setAttribute(key, value === true ? '' : String(value))
  }
}

function requestUpgrade(dom, options) {
  const tag = dom.tagName.toLowerCase()
  if (typeof options.loadBlock === 'function' && !window.customElements?.get(tag)) {
    options.loadBlock(tag)
  }
}
