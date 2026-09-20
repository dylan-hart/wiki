import { Node, mergeAttributes } from '@tiptap/core'

/**
 * `:tabler:home:` -- an Iconify reference written the way an emoji shortcode is. The inner colon is
 * what reliably tells one apart from a `:smile:`-style emoji shortcode.
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
