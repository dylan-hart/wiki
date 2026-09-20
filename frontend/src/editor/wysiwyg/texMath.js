import katex from 'katex'

import { Node, mergeAttributes } from '@tiptap/core'

/**
 * `^`-anchored because `marked` hands a tokenizer the remaining source starting exactly where its
 * own `start()` said a candidate begins, rather than the sticky-regex style `markdown-it` inline
 * rules use. The inline pattern's surrounding guards keep ordinary prose (`$5`, `$10`) from being
 * read as a formula.
 *
 * One node with a `display` attr, not two node types, because the renderer treats both delimiters
 * as the same inline token: `$$...$$` can sit mid-paragraph exactly like `$...$` does.
 */
const TEX_INLINE = /^\$(?!\$)(?=\S)((?:\\.|[^\\$])+?)(?<=\S)\$(?!\d)/
const TEX_DISPLAY = /^\$\$([\s\S]*?)\$\$/

/**
 * A formula that fails to typeset says so rather than vanishing. The message is plain text, not the
 * published page's markup, because it only ever lands in an attribute or a NodeView's text node.
 */
function renderFormula(formula, display) {
  const trimmed = (formula || '').trim()
  if (!trimmed) {
    return { html: '', error: 'This formula is empty.' }
  }
  try {
    return {
      html: katex.renderToString(trimmed, {
        displayMode: display,
        output: 'htmlAndMathml',
        throwOnError: true,
        macros: {}
      }),
      error: null
    }
  } catch (err) {
    return { html: '', error: `Could not be typeset: ${err.message ?? err}` }
  }
}

export const TexMath = Node.create({
  name: 'texMath',

  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      formula: { default: '' },
      display: { default: false }
    }
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-tex-math]',
        getAttrs: (element) => ({
          formula: element.getAttribute('data-formula') || '',
          display: element.getAttribute('data-display') === 'true'
        })
      }
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    const { html, error } = renderFormula(node.attrs.formula, node.attrs.display)
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-tex-math': '',
        'data-formula': node.attrs.formula,
        'data-display': String(node.attrs.display),
        class: error ? 'tex-math-error' : 'katex-wysiwyg',
        title: error || undefined
      }),
      error || ''
    ]
  },

  markdownTokenName: 'texMath',

  parseMarkdown: (token, h) =>
    h.createNode('texMath', { formula: token.formula, display: token.display }),

  renderMarkdown: (node) => {
    const formula = node.attrs?.formula ?? ''
    return node.attrs?.display ? `$$${formula}$$` : `$${formula}$`
  },

  markdownTokenizer: {
    name: 'texMath',
    level: 'inline',
    start(src) {
      let index = src.indexOf('$')
      while (index !== -1) {
        const rest = src.slice(index)
        const pattern = rest.charCodeAt(1) === 0x24 ? TEX_DISPLAY : TEX_INLINE
        if (pattern.test(rest)) {
          return index
        }
        index = src.indexOf('$', index + 1)
      }
      return -1
    },
    tokenize(src) {
      if (src.charCodeAt(0) !== 0x24 /* $ */) {
        return undefined
      }
      const display = src.charCodeAt(1) === 0x24
      const pattern = display ? TEX_DISPLAY : TEX_INLINE
      const match = pattern.exec(src)
      if (!match) {
        return undefined
      }
      return { type: 'texMath', raw: match[0], formula: match[1], display }
    }
  }
})

export default TexMath
