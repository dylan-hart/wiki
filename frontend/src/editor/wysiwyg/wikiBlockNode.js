import { Node, mergeAttributes } from '@tiptap/core'

import {
  WIKI_BLOCK_NODE_NAME,
  parseWikiBlockMarkdown,
  renderWikiBlockMarkdown,
  wikiBlockMarkdownTokenizer
} from './wikiBlockMarkdown'
import { createWikiBlockNodeView } from './wikiBlockNodeView'

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

  markdownTokenizer: wikiBlockMarkdownTokenizer,
  parseMarkdown: parseWikiBlockMarkdown,
  renderMarkdown: renderWikiBlockMarkdown
})
