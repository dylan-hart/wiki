/**
 * The text of `node` as the document holds it. In the WYSIWYG editor a block's light DOM is
 * ProseMirror's own view of the document, and that also carries widget decorations: a
 * collaborator's caret is a widget whose label is their name, as a text node, drawn right inside
 * the fence. ProseMirror marks every widget it draws `contenteditable="false"`, and nothing else in
 * a block body carries that attribute, so a subtree marked that way is skipped rather than read as
 * part of the body -- `textContent` would read `Alice{"v":2,…}`.
 *
 * @param {Node} node
 * @returns {string}
 */
export function documentText(node) {
  let text = ''
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE || child.nodeType === Node.CDATA_SECTION_NODE) {
      text += child.data
    } else if (
      child.nodeType === Node.ELEMENT_NODE &&
      child.getAttribute('contenteditable') !== 'false'
    ) {
      text += documentText(child)
    }
  }
  return text
}

/**
 * `documentText` rather than `innerHTML` undoes the escaping that put `&amp;` and `--&gt;` into the
 * markup, giving back what was actually typed. A `<pre>` wins outright: inside a fence the text
 * arrives exactly as typed, where an unfenced body has been through markdown's typographer --
 * quotes rewritten, `_`/`^` read as emphasis, a lone backslash dropped. That is why `fenced` is
 * reported back, for a block to pass on when the source then fails to parse.
 *
 * @param {Element} el
 * @returns {{ source: string, fenced: boolean }}
 */
export function readFencedSource(el) {
  const fence = el.querySelector('pre')
  return {
    source: documentText(fence ?? el).trim(),
    fenced: Boolean(fence)
  }
}
