import { Node, mergeAttributes } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'

import {
  WIKI_BLOCK_NODE_NAME,
  parseWikiBlockMarkdown,
  renderWikiBlockMarkdown,
  wikiBlockMarkdownTokenizer
} from './wikiBlockMarkdown'
import { createWikiBlockNodeView } from './wikiBlockNodeView'

/**
 * A block that shows none of its children as page content: its body is a fence the block draws
 * itself (a whiteboard, a diagram, a formula), or it has no body at all. Joining a line into one
 * would move that line into a body nobody sees, in the editor or on the published page.
 */
export function isOpaqueWikiBlock(node) {
  if (node?.type.name !== WIKI_BLOCK_NODE_NAME) {
    return false
  }
  let opaque = true
  node.forEach((child) => {
    opaque &&= child.type.name === 'codeBlock'
  })
  return opaque
}

/** Where ProseMirror's own join commands would cut: `findCutBefore`/`findCutAfter`. */
function joinCut($cursor, dir) {
  if ($cursor.parent.type.spec.isolating) {
    return null
  }
  for (let depth = $cursor.depth - 1; depth >= 0; depth--) {
    const parent = $cursor.node(depth)
    const index = $cursor.index(depth)
    if (dir < 0 ? index > 0 : index + 1 < parent.childCount) {
      return {
        depth,
        node: parent.child(dir < 0 ? index - 1 : index + 1),
        pos: dir < 0 ? $cursor.before(depth + 1) : $cursor.after(depth + 1)
      }
    }
    if (parent.type.spec.isolating) {
      return null
    }
  }
  return null
}

/**
 * Backspace at the start of a line below an opaque block, or Delete at the end of a line above
 * one, selects the block instead of joining. The join would otherwise move the line into the
 * block's body (Backspace), or lift the block's fence out into the page (Delete). An empty line
 * is removed as well, since removing it is what the key was pressed for.
 *
 * Not `isolating: true` on the node: that would also stop Enter on an empty last line lifting the
 * caret out of a container block such as a tab, the way out of one.
 *
 * @param {-1|1} dir `-1` for Backspace, `1` for Delete.
 * @returns {import('@tiptap/pm/state').Command}
 */
export function selectOpaqueNeighbour(dir) {
  return (state, dispatch) => {
    const { $cursor } = state.selection
    if (!$cursor) {
      return false
    }
    const atEdge =
      dir < 0 ? $cursor.parentOffset === 0 : $cursor.parentOffset === $cursor.parent.content.size
    const cut = atEdge ? joinCut($cursor, dir) : null
    if (!cut || !isOpaqueWikiBlock(cut.node)) {
      return false
    }
    if (dispatch) {
      const tr = state.tr
      let blockPos = dir < 0 ? cut.pos - cut.node.nodeSize : cut.pos
      const container = $cursor.node(-1)
      const index = $cursor.index(-1)
      if (
        $cursor.parent.content.size === 0 &&
        cut.depth === $cursor.depth - 1 &&
        container.canReplace(index, index + 1)
      ) {
        tr.delete($cursor.before(), $cursor.after())
        if (dir > 0) {
          blockPos -= $cursor.parent.nodeSize
        }
      }
      dispatch(tr.setSelection(NodeSelection.create(tr.doc, blockPos)).scrollIntoView())
    }
    return true
  }
}

/**
 * One generic node behind every `<block-*>` custom element rather than one per kind: a tabset's
 * panel is not a special case, its body is the same ordinary page content every other block holds.
 * `content: 'block*'` covers every one of those shapes, and `group: 'block'` makes the node valid
 * content for itself, so `block-tabs` nesting `block-tab` panels needs nothing further.
 */
export const WikiBlock = Node.create({
  name: WIKI_BLOCK_NODE_NAME,
  group: 'block',
  content: 'block*',
  defining: true,

  addOptions() {
    return {
      /**
       * Called with a block's element tag whenever a NodeView mounts one the browser has not
       * upgraded yet, giving the caller its chance to dynamically import it. Left `null` here so
       * this node -- and its own tests -- need no store or site context to construct.
       */
      loadBlock: null
    }
  },

  addAttributes() {
    return {
      /** The tag without its `block-` prefix: `tabs`, `infobox`, `tab`. */
      block: { default: null },
      /** Opening-line props by name; a bare flag is `true`, everything else the raw string. */
      props: { default: {} }
    }
  },

  renderHTML({ node }) {
    const attrs = {}
    for (const [key, value] of Object.entries(node.attrs.props ?? {})) {
      attrs[key] = value === true ? '' : String(value)
    }
    return [`block-${node.attrs.block}`, mergeAttributes(attrs), 0]
  },

  addNodeView() {
    return createWikiBlockNodeView(this.options)
  },

  addKeyboardShortcuts() {
    const backward = () => selectOpaqueNeighbour(-1)(this.editor.state, this.editor.view.dispatch)
    const forward = () => selectOpaqueNeighbour(1)(this.editor.state, this.editor.view.dispatch)
    return {
      Backspace: backward,
      'Mod-Backspace': backward,
      'Shift-Backspace': backward,
      Delete: forward,
      'Mod-Delete': forward
    }
  },

  markdownTokenizer: wikiBlockMarkdownTokenizer,
  parseMarkdown: parseWikiBlockMarkdown,
  renderMarkdown: renderWikiBlockMarkdown
})
