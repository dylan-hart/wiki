import { LitElement, html, css, unsafeCSS } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { renderToString } from 'katex'
import katexCss from 'katex/dist/katex.min.css'
/*
  mhchem, imported for its side effect: the contrib module reaches into the same katex instance this
  file imports and defines `\ce`, `\pu` and the machinery behind them as macros. There is nothing to
  call and nothing to configure — the import is the installation, which is why it has no binding.

  It is the KaTeX port of the same extension the MathJax block loads, so `\ce{CO2 + C -> 2 CO}` means
  the same thing in both blocks.
*/
import 'katex/contrib/mhchem'
import { readFencedSource } from '../shared/body.js'
import { explainEmptySource, explainSourceFailure, figureStyles } from '../shared/figure.js'
import { renderError } from '../shared/render.js'
import { captionStyles, errorBox } from '../shared/styles.js'
import { DarkMode } from '../shared/theme.js'

/*
  KaTeX's stylesheet, split in two.

  A `@font-face` is a document-level thing: the rule declares a family, and a stylesheet inside a
  shadow root is not where the browser looks for one. So the faces go to the document — once, when
  this module loads, however many formulas the page turns out to hold — and everything else goes into
  the shadow root with the component, where the class names KaTeX writes into its markup are.

  The `url()` in each face is already a data URI by this point: see `cssAsString` in
  `rollup.config.mjs` for why a block cannot leave its fonts as files.
*/
const FONT_FACE_RULE = /@font-face\{[^{}]*\}/g
const KATEX_FONT_FACES = (katexCss.match(FONT_FACE_RULE) ?? []).join('')
const KATEX_RULES = katexCss.replace(FONT_FACE_RULE, '')

const fontSheet = new CSSStyleSheet()
fontSheet.replaceSync(KATEX_FONT_FACES)
document.adoptedStyleSheets = [...document.adoptedStyleSheets, fontSheet]

/**
 * Block KaTeX
 */
export class BlockKatexElement extends LitElement {
  /**
   * Metadata for the admin area and the editor's block picker. Collected at build time into
   * `compiled/blocks.manifest.json`, which the server reads to register the block. Values must be
   * plain literals. See `props` in `block-index` for what the picker does with that list.
   */
  static definition = {
    block: 'katex',
    name: 'KaTeX',
    description:
      "Typesets a TeX formula with KaTeX, including chemical equations written with mhchem's \\ce and \\pu commands.",
    icon: 'tabler:math-function',
    /*
      Fenced, and not as a nicety: TeX is made of the characters markdown reads as its own. A lone
      backslash goes missing, `_` and `^` open emphasis, `\\` at the end of a line is a break, and the
      typographer rewrites quotes and dashes inside the source. Inside a fence it arrives as typed.
    */
    template: `\`\`\`latex
x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}
\`\`\``,
    props: [
      {
        name: 'caption',
        type: 'string',
        label: 'Caption',
        hint: 'Shown under the formula.'
      },
      {
        name: 'align',
        type: 'select',
        label: 'Alignment',
        options: ['center', 'left'],
        default: 'center'
      }
    ]
  }

  static get styles() {
    return [
      // -> KaTeX first, so the rules below win where the two touch the same thing
      unsafeCSS(KATEX_RULES),
      errorBox,
      captionStyles,
      figureStyles,
      css`
        /* -> The block owns its spacing; KaTeX's own 1em above and below would double it up */
        .drawing .katex-display {
          margin: 0;
        }
      `
    ]
  }

  static get properties() {
    return {
      /**
       * Text shown under the formula
       * @type {string}
       */
      caption: { type: String },

      /**
       * Where the formula sits in the column, `center` or `left`
       * @type {string}
       */
      align: { type: String },

      // Internal Properties
      _markup: { state: true },
      _error: { state: true }
    }
  }

  constructor() {
    super()
    this.caption = ''
    this.align = 'center'
    this._markup = ''
    this._error = ''
    // -> Puts `dark` on this element for the styles above to key off
    this._darkMode = new DarkMode(this)
  }

  /**
   * Typeset the source, or say why it could not be.
   */
  _typeset(source, fenced) {
    try {
      this._markup = renderToString(source, {
        displayMode: true,
        /*
          Both output forms: the drawing a reader sees, and a MathML copy of the same expression that
          KaTeX hides and a screen reader announces. That is why this block writes no aria-label — the
          expression itself is in the markup, read as mathematics rather than as TeX source.
        */
        output: 'htmlAndMathml',
        /*
          Handing the error on rather than drawing it: KaTeX's other answer to bad input is to print
          the source in red where the formula should be, which says nothing about what is wrong with
          it. Thrown, it reaches the catch below and the panel in `render`, with the position KaTeX
          found the problem at.
        */
        throwOnError: true,
        /*
          Macros are the one piece of state a render leaves behind: `\gdef` writes into this object,
          and KaTeX would carry the definition into whatever it typesets next if every block shared
          one. A formula defines macros for itself.
        */
        macros: {}
        // -> `trust` is left at its default. It gates \href, \url and \includegraphics, which put a
        //    link or a remote image into the page from inside TeX — not what a formula is for, and
        //    the same reason the MathJax block leaves out the `html` package.
      })
      this._error = ''
    } catch (err) {
      this._markup = ''
      this._error = explainSourceFailure('formula could not be typeset', err, fenced)
    }
  }

  firstUpdated() {
    const { source, fenced } = readFencedSource(this)
    if (!source) {
      this._error = explainEmptySource('formula', { source: 'TeX source' })
      return
    }
    this._typeset(source, fenced)
  }

  render() {
    if (this._error) {
      return renderError(this._error)
    }
    return html`
      <div class="formula ${this.align === 'left' ? 'is-left' : ''}">
        <div class="drawing">${unsafeHTML(this._markup)}</div>
        ${this.caption ? html`<div class="caption">${this.caption}</div>` : null}
      </div>
    `
  }
}

window.customElements.define('block-katex', BlockKatexElement)
