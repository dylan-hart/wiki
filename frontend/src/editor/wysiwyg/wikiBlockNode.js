import { Node, mergeAttributes } from '@tiptap/core'

import {
  WIKI_BLOCK_NODE_NAME,
  parseWikiBlockMarkdown,
  renderWikiBlockMarkdown,
  wikiBlockMarkdownTokenizer
} from './wikiBlockMarkdown'
import { createWikiBlockNodeView } from './wikiBlockNodeView'

/**
 * The Tiptap node behind every Cardinal-specific `<block-*>` custom element -- a leaf block
 * (`block-countdown`, `block-katex`, …) and a tabset (`block-tabs` holding `block-tab` panels)
 * alike, one generic node rather than one per kind.
 *
 * A single node covers both because a tabset's panel is not a special case: `block-tab`'s own doc
 * comment says so directly -- "Its content is ordinary page content, left in the light DOM" -- the
 * same body every other block already has (a paragraph, a list, a fenced code sample, or nothing at
 * all for a self-closing one like `block-countdown`/`block-map`). `content: 'block*'` covers every
 * one of those shapes, and `group: 'block'` makes the node its own valid content too, the same way
 * `blockquote`'s `content: 'block+'` already nests arbitrary blocks of its own -- so `block-tabs`
 * holding several `wikiBlock` panels, each itself holding ordinary block content, needs nothing
 * beyond what this one node already provides.
 *
 * See `wikiBlockMarkdown.js` for the markdown parse/tokenize/serialize half (the MDC
 * `::block-name{...}` … `::` syntax `renderers/modules/markdown-it-blocks.js` already reads for the
 * read view) and `wikiBlockNodeView.js` for what actually mounts the real `<block-*>` element.
 */
export const WikiBlock = Node.create({
  name: WIKI_BLOCK_NODE_NAME,
  group: 'block',
  content: 'block*',
  defining: true,

  addOptions() {
    return {
      /**
       * Called with a block's element tag (`block-tabs`) whenever a NodeView mounts one the browser
       * has not upgraded yet -- the caller's chance to dynamically import it
       * (`commonStore.loadBlocks()`), mirroring the read view's own `collectBlocksToLoad` scan.
       * `EditorWysiwyg.vue` supplies the real one via `loadBlock.js`'s `createBlockLoader()`; left
       * `null` here so this node -- and its own tests -- need no store or site context to construct.
       */
      loadBlock: null
    }
  },

  addAttributes() {
    return {
      /** The block's own tag, without the `block-` prefix, e.g. `tabs`, `infobox`, `tab`. */
      block: { default: null },
      /**
       * The opening line's own props, by name, exactly as MDC would attribute them -- a bare flag
       * (`hideToolbar`) is `true`, everything else is the raw string MDC read off the line. See
       * `wikiBlockAttrs.js`.
       */
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
