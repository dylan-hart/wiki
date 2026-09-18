import { Node, mergeAttributes } from '@tiptap/core'

/**
 * `:tabler:home:` -- an Iconify reference written the way an emoji shortcode is, ported from
 * `renderers/modules/markdown-it-icon-shortcode.js`'s own `ICON_SHORTCODE` regex (see that file's
 * doc comment for why the inner colon reliably tells this apart from `:smile:`-style emoji, and why
 * the prefix must start with a letter) onto `@tiptap/markdown`'s `marked`-based tokenizer.
 *
 * Rendered with the same `<iconify-icon>` custom element the published page and the rest of this
 * app use (`components/shared/WIcon.vue`, `boot/iconify.js`) -- Vite's `isCustomElement` rule
 * already tells Vue's compiler to leave that tag alone, so it needs no special handling as a
 * ProseMirror `renderHTML` array either.
 */
const ICON_SHORTCODE = /^:([a-z][a-z\d]*(?:-[a-z\d]+)*):([a-z\d]+(?:[-.][a-z\d]+)*):/

export const IconShortcode = Node.create({
  name: 'iconShortcode',

  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      icon: { default: '' }
    }
  },

  parseHTML() {
    return [
      {
        tag: 'iconify-icon[data-shortcode]',
        getAttrs: (element) => ({ icon: element.getAttribute('icon') || '' })
      }
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'iconify-icon',
      mergeAttributes(HTMLAttributes, { icon: node.attrs.icon, 'data-shortcode': '' })
    ]
  },

  markdownTokenName: 'iconShortcode',

  parseMarkdown: (token, h) => h.createNode('iconShortcode', { icon: token.icon }),

  renderMarkdown: (node) => `:${node.attrs?.icon ?? ''}:`,

  markdownTokenizer: {
    name: 'iconShortcode',
    level: 'inline',
    start(src) {
      let index = src.indexOf(':')
      while (index !== -1) {
        if (ICON_SHORTCODE.test(src.slice(index))) {
          return index
        }
        index = src.indexOf(':', index + 1)
      }
      return -1
    },
    tokenize(src) {
      if (src.charCodeAt(0) !== 0x3a /* : */) {
        return undefined
      }
      const match = ICON_SHORTCODE.exec(src)
      if (!match) {
        return undefined
      }
      return { type: 'iconShortcode', raw: match[0], icon: `${match[1]}:${match[2]}` }
    }
  }
})

export default IconShortcode
