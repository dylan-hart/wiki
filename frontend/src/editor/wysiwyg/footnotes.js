import { Node, mergeAttributes } from '@tiptap/core'

/**
 * The syntax mirrors the backend's `markdown-it-footnote`, but a definition stays exactly where it
 * was typed rather than being collected and renumbered at the end of the page as that renderer
 * does: the editor round-trips the author's markdown, it does not reproduce the render.
 *
 * A definition body is a single line. The 4-space-indented continuation paragraph
 * `markdown-it-footnote` also allows is read back as separate ordinary content rather than folded
 * into the definition.
 */
const REFERENCE = /^\[\^([^\]\s]+)\]/
const DEFINITION = /^\[\^([^\]\s]+)\]:[ \t]*([^\n]*)(?:\n|$)/

export const FootnoteReference = Node.create({
  name: 'footnoteReference',

  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      label: { default: '' }
    }
  },

  parseHTML() {
    return [
      {
        tag: 'sup[data-footnote-ref]',
        getAttrs: (element) => ({ label: element.getAttribute('data-label') || '' })
      }
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'sup',
      mergeAttributes(HTMLAttributes, {
        'data-footnote-ref': '',
        'data-label': node.attrs.label,
        class: 'footnote-ref'
      }),
      `[${node.attrs.label}]`
    ]
  },

  markdownTokenName: 'footnoteRef',

  parseMarkdown: (token, h) => h.createNode('footnoteReference', { label: token.label }),

  renderMarkdown: (node) => `[^${node.attrs?.label ?? ''}]`,

  markdownTokenizer: {
    name: 'footnoteRef',
    level: 'inline',
    start(src) {
      // -> A definition (`[^label]:`) is claimed at the block level before this runs, so any
      //    `[^label]` still visible here is a genuine reference.
      let index = src.indexOf('[^')
      while (index !== -1) {
        if (REFERENCE.test(src.slice(index))) {
          return index
        }
        index = src.indexOf('[^', index + 1)
      }
      return -1
    },
    tokenize(src) {
      const match = REFERENCE.exec(src)
      if (!match) {
        return undefined
      }
      return { type: 'footnoteRef', raw: match[0], label: match[1] }
    }
  }
})

export const FootnoteDefinition = Node.create({
  name: 'footnoteDefinition',

  group: 'block',
  content: 'inline*',
  defining: true,

  addAttributes() {
    return {
      label: { default: '' }
    }
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-footnote-def]',
        getAttrs: (element) => ({ label: element.getAttribute('data-label') || '' }),
        contentElement: 'span'
      }
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-footnote-def': '',
        'data-label': node.attrs.label,
        class: 'footnote-definition'
      }),
      ['span', { class: 'footnote-definition-label' }, `[${node.attrs.label}]:`],
      ['span', { class: 'footnote-definition-body' }, 0]
    ]
  },

  markdownTokenName: 'footnoteDef',

  parseMarkdown: (token, h) =>
    h.createNode('footnoteDefinition', { label: token.label }, h.parseInline(token.tokens || [])),

  renderMarkdown: (node, h) =>
    `[^${node.attrs?.label ?? ''}]: ${h.renderChildren(node.content || [])}`,

  markdownTokenizer: {
    name: 'footnoteDef',
    level: 'block',
    start(src) {
      const match = src.match(/^\[\^[^\]\s]+\]:/m)
      return match?.index ?? -1
    },
    tokenize(src, _tokens, lexer) {
      const match = DEFINITION.exec(src)
      if (!match) {
        return undefined
      }
      return {
        type: 'footnoteDef',
        raw: match[0],
        label: match[1],
        tokens: lexer.inlineTokens(match[2])
      }
    }
  }
})

export default [FootnoteReference, FootnoteDefinition]
