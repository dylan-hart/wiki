import katex from 'katex'

import { Node, mergeAttributes } from '@tiptap/core'

/**
 * Inline and display TeX for the WYSIWYG editor -- `$x^2$` and `$$x^2$$` -- ported from
 * `renderers/modules/markdown-it-tex.js`'s own `TEX_INLINE`/`TEX_DISPLAY` regexes (see that file's
 * doc comments for the currency-guard reasoning: `$5`, `$10` and the rest of ordinary prose must
 * never be read as a formula) onto `@tiptap/markdown`'s `marked`-based tokenizer, and re-anchored
 * with `^` since `marked` always hands a tokenizer the remaining source starting exactly where its
 * own `start()` said a candidate begins, rather than the sticky-regex/`state.pos` style
 * `markdown-it` inline rules use.
 *
 * Modeled as ONE node, `texMath`, with a `display` attr -- not two separate node types -- because
 * that is what the backend renderer itself does: both delimiters are the SAME `tex_math` inline
 * token there (`texMath()`'s own `display` flag), never a block-level construct, so `$$...$$` can
 * sit mid-paragraph exactly like `$...$` does. Mirroring that keeps the editor and the published
 * page agreeing on what these constructs even are.
 */
const TEX_INLINE = /^\$(?!\$)(?=\S)((?:\\.|[^\\$])+?)(?<=\S)\$(?!\d)/
const TEX_DISPLAY = /^\$\$([\s\S]*?)\$\$/

/**
 * Renders a formula's KaTeX HTML, or a small inline error string when it fails to typeset -- the
 * same "say why, don't vanish" treatment `texMathError` gives on the published page, but plain text
 * here since this only ever lands inside a `title`/`data-*` attribute or a NodeView's own text node,
 * never raw page HTML that a sanitizer has to reason about.
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
