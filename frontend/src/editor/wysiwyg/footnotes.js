import { Node, mergeAttributes } from '@tiptap/core'

/**
 * Footnotes for the WYSIWYG editor -- `Body text[^1].` plus a `[^1]: The note itself.` definition
 * -- mirroring the syntax the backend's `markdown-it-footnote` dependency parses (no fork-owned
 * module to port from here; that package's grammar is the reference).
 *
 * Two node types, matching the two distinct things markdown-it-footnote itself distinguishes:
 * `footnoteReference` (inline atom, `[^label]`, wherever the author places it in running text) and
 * `footnoteDefinition` (block, `[^label]: text`, wherever the author places IT -- markdown-it-footnote
 * collects every definition and renders them as a numbered list at the end of the page regardless of
 * source position, but the *editor's* job is round-tripping the author's own markdown, not
 * reproducing that end-of-page renumbering, so a definition stays exactly where it was typed).
 *
 * v1 limitation, deliberate: a definition's body is a single line. `markdown-it-footnote` (and
 * Pandoc before it) also allow a 4-space-indented CONTINUATION paragraph under a definition; this
 * editor does not parse that back into the definition (an indented paragraph is read as separate,
 * ordinary content instead) rather than silently dropping it. Revisit if that shape shows up in a
 * real page.
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
      // -> A definition (`[^label]:`) is claimed at the block level before this ever runs, so any
      //    `[^label]` this inline tokenizer still sees is a genuine reference.
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
