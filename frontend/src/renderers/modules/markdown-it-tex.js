import katex from 'katex'

import { escape } from 'es-toolkit/string'

/**
 * Inline TeX, `$x^2$`. The guards separate a formula from ordinary currency prose (`$5`, `$10`) by
 * adjacency rather than content, after Pandoc's own `tex_math_dollars`:
 *
 *  - `(?!\$)` -- two dollars together START display math, so this rule steps aside for
 *    `TEX_DISPLAY`.
 *  - `(?=\S)` / `(?<=\S)` -- a real formula never has space touching its delimiters, but `$ 5 and
 *    $ 10` does.
 *  - `(?!\d)` -- a candidate closing `$` followed straight by a digit is the OPEN of the next
 *    currency figure, as in "It costs $5 or $10".
 *
 * The content branch allows an escaped character so KaTeX's `\$` does not end the match early, and
 * is non-greedy so a formula ends at the NEAREST qualifying `$`.
 */
const TEX_INLINE = /\$(?!\$)(?=\S)((?:\\.|[^\\$])+?)(?<=\S)\$(?!\d)/y

/**
 * Display TeX, `$$x^2$$`. No currency amount is written with a doubled `$`, so none of
 * `TEX_INLINE`'s adjacency guards apply. Empty content matches deliberately: an author who
 * scaffolded `$$` and typed nothing into it yet gets the "formula is empty" panel rather than a
 * silently vanished pair of dollars.
 */
const TEX_DISPLAY = /\$\$([\s\S]*?)\$\$/y

/**
 * KaTeX runs synchronously with nothing to await, so a formula is resolved to literal HTML/MathML
 * here at render time rather than deferred to a backend pass the way `inlineIcons()` resolves an
 * `<iconify-icon>` (an icon needs a network or database lookup; a formula does not). The backend's
 * `helpers/htmlSanitizePolicy.ts` has to keep allow-listing the MathML tags and the inline `style`
 * attribute this produces.
 *
 * `trust` stays at its default (off): it gates `\href`, `\url` and `\includegraphics`, none of which
 * belong to an author typing a formula into a sentence.
 */
function texMathHtml(source, display) {
  const trimmed = source.trim()
  if (!trimmed) {
    return texMathError(
      'This formula is empty. Its TeX source goes directly between the $ delimiters.',
      display
    )
  }
  try {
    return katex.renderToString(trimmed, {
      displayMode: display,
      output: 'htmlAndMathml',
      throwOnError: true,
      macros: {}
    })
  } catch (err) {
    return texMathError(`This formula could not be typeset: ${err.message ?? err}`, display)
  }
}

/**
 * A `<span>` even for a display-mode failure, deliberately: this token sits inside a markdown-it
 * paragraph's inline content, and `span` never triggers an HTML parser's implied `</p>`, so nesting
 * stays valid however `.tex-math-error` then displays it.
 */
function texMathError(message, display) {
  return `<span class="tex-math-error${display ? ' tex-math-error--display' : ''}">${escape(message)}</span>`
}

function texMath(state, silent) {
  if (state.src.charCodeAt(state.pos) !== 0x24 /* $ */) {
    return false
  }
  const display = state.src.charCodeAt(state.pos + 1) === 0x24
  const pattern = display ? TEX_DISPLAY : TEX_INLINE
  pattern.lastIndex = state.pos
  const match = pattern.exec(state.src)
  // -> Bounded by `posMax`, not the end of the line: inside a link label, that is the end of what is
  //    being tokenized
  if (!match || state.pos + match[0].length > state.posMax) {
    return false
  }
  if (!silent) {
    const token = state.push('tex_math', 'span', 0)
    token.markup = match[0]
    token.content = match[1]
    token.meta = { display }
  }
  state.pos += match[0].length
  return true
}

export default (md) => {
  /*
    Ahead of `text`, so the whole delimited span is claimed in one go rather than reaching `text`
    already split around the `$` characters.
  */
  md.inline.ruler.before('text', 'tex_math', texMath)
  md.renderer.rules.tex_math = (tokens, idx) =>
    texMathHtml(tokens[idx].content, tokens[idx].meta.display)
}
