import katex from 'katex'

import { escape } from 'es-toolkit/string'

/**
 * Inline TeX, `$x^2$` -- the literal single-dollar syntax 2.5.x authors wrote mid-sentence, confirmed
 * against upstream `markdown-it-katex`/`markdown-it-mathjax` and the false-positive class their own
 * guard existed for: `$5`, `$10` and the rest of ordinary currency prose. The rule (after Pandoc's own
 * `tex_math_dollars`, which solves exactly this) is adjacency, not content:
 *
 *  - `(?!\$)` on the open -- two dollars together are the START of display math (`$$`), never a
 *    zero-content inline formula, so this rule steps aside and lets `TEX_DISPLAY` have it.
 *  - `(?=\S)` right after the open, and `(?<=\S)` right before the close -- a real formula never has
 *    space touching its delimiters, but `$ 5 and $ 10` (space after the `$`) reads exactly like
 *    currency with awkward spacing, and this is what tells the two apart.
 *  - `(?!\d)` after the close -- the close of a genuine formula is never immediately followed by a
 *    digit, but the close of a currency figure usually is: "It costs $5 or $10" finds a candidate
 *    closing `$` right before "10" and rejects it on this alone, which is what keeps the whole phrase
 *    literal instead of reading "5 or " as a formula.
 *
 * `(?:\\.|[^\\$])+?` is the content itself: an escaped character (so `\$` inside a formula -- KaTeX's
 * own escape for a literal dollar sign glyph -- does not end the match early) or anything that is
 * neither a backslash nor a bare `$`. Non-greedy, so a formula ends at the NEAREST qualifying `$`
 * rather than swallowing everything up to the last one on the line.
 */
const TEX_INLINE = /\$(?!\$)(?=\S)((?:\\.|[^\\$])+?)(?<=\S)\$(?!\d)/y

/**
 * Display TeX, `$$x^2$$` -- centered, its own line typographically even mid-paragraph. No currency
 * amount is ever written with a doubled `$`, so none of `TEX_INLINE`'s adjacency guards apply here:
 * anything between the nearest pair of `$$` is the formula, including nothing at all -- an author who
 * scaffolds `$$` and has not typed a formula into it yet gets the same "this formula is empty" panel
 * `block-katex`/`block-mathjax` show for an empty fence, not a silently vanished pair of dollars.
 */
const TEX_DISPLAY = /\$\$([\s\S]*?)\$\$/y

/**
 * The literal HTML/MathML for one formula, or the error panel saying why it could not be typeset.
 *
 * Resolved here, synchronously, at markdown-it render time -- not deferred to a save-time pass in
 * `models/rendering.ts` the way `inlineIcons()` there resolves `<iconify-icon>` into a literal `<svg>`.
 * That deferral exists because an icon takes a network round trip (or a database lookup) to resolve;
 * a TeX formula does not; KaTeX runs synchronously in pure JS with nothing to await, exactly like the
 * syntax highlighter in `markdown.js`'s own `highlight` option (`hljs.highlight`, called synchronously
 * inside it). So the SAME literal-HTML outcome the icon path reaches through a second
 * backend pass, this reaches in one step, at the point the HTML is first produced -- which is also
 * the point whose OUTPUT is what gets sent up and stored, per that file's one-render-is-both-preview-
 * and-storage model. `models/rendering.ts`'s sanitiser already allow-lists the MathML tags and the
 * inline `style` attribute this produces -- see `BASE_ALLOWED_TAGS`'s "KaTeX renders to MathML" note.
 *
 * `trust` is left at its default (off), same reasoning as `block-katex`: it gates `\href`, `\url` and
 * `\includegraphics`, none of which belong to an author typing a formula into a sentence.
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
 * The error panel itself -- reusing `block-katex`/`block-mathjax`'s own treatment (say why, don't
 * vanish) rather than inventing a second one, styled by `.tex-math-error` in `_page-contents.scss`.
 *
 * A `<span>` even for a display-mode failure, deliberately: this token sits inside a markdown-it
 * paragraph's inline content, and only a handful of tag names trigger an HTML parser's implied `</p>`
 * -- `span` is never one of them, so nesting stays valid however the CSS class then displays it.
 */
function texMathError(message, display) {
  return `<span class="tex-math-error${display ? ' tex-math-error--display' : ''}">${escape(message)}</span>`
}

/**
 * The inline rule behind both delimiters. `state.pos` is at a `$` for any of this to be worth trying;
 * a second `$` right there is what tells the two syntaxes apart.
 */
function texMath(state, silent) {
  if (state.src.charCodeAt(state.pos) !== 0x24 /* $ */) {
    return false
  }
  const display = state.src.charCodeAt(state.pos + 1) === 0x24
  const pattern = display ? TEX_DISPLAY : TEX_INLINE
  pattern.lastIndex = state.pos
  const match = pattern.exec(state.src)
  // -> Bounded by `posMax` for the same reason `iconShortcode` is: inside a link label that is the end
  //    of what is being tokenized, not the end of the line
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
    TeX authoring, `$x^2$` and `$$x^2$$` -- see `TEX_INLINE`/`TEX_DISPLAY` above for the currency
    guard and `texMathHtml` for the rendering strategy. Registered the same way as the icon
    shortcode: ahead of `text`, so the whole delimited span is claimed in one go rather
    than reaching `text` already split around the `$` characters.
  */
  md.inline.ruler.before('text', 'tex_math', texMath)
  md.renderer.rules.tex_math = (tokens, idx) =>
    texMathHtml(tokens[idx].content, tokens[idx].meta.display)
}
