import { LitElement, html, css, unsafeCSS } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { renderToString } from 'katex'
import katexCss from 'katex/dist/katex.min.css'
/*
  Side-effect import, hence no binding: the contrib module defines `\ce` and `\pu` as macros on the
  same katex instance this file imports. There is nothing to call and nothing to configure.
*/
import 'katex/contrib/mhchem'
import { readFencedSource } from '../shared/body.js'
import { explainEmptySource, explainSourceFailure, figureStyles } from '../shared/figure.js'
import { renderError } from '../shared/render.js'
import { captionStyles, errorBox } from '../shared/styles.js'
import { DarkMode } from '../shared/theme.js'

/*
  KaTeX's stylesheet, split in two: a `@font-face` inside a shadow root is never looked at, so the
  faces are adopted by the document once per module load and the rest stays with the component,
  where the class names KaTeX writes into its markup are.
*/
const FONT_FACE_RULE = /@font-face\{[^{}]*\}/g
const KATEX_FONT_FACES = (katexCss.match(FONT_FACE_RULE) ?? []).join('')
const KATEX_RULES = katexCss.replace(FONT_FACE_RULE, '')

const fontSheet = new CSSStyleSheet()
fontSheet.replaceSync(KATEX_FONT_FACES)
document.adoptedStyleSheets = [...document.adoptedStyleSheets, fontSheet]

export class BlockKatexElement extends LitElement {
  /**
   * Read out of the source text at build time into `compiled/blocks.manifest.json`, so every value
   * has to stay a plain literal.
   */
  static definition = {
    block: 'katex',
    name: 'KaTeX',
    description:
      "Typesets a TeX formula with KaTeX, including chemical equations written with mhchem's \\ce and \\pu commands.",
    icon: 'tabler:math-function',
    /*
      Fenced, and not as a nicety: TeX is made of the characters markdown reads as its own —
      backslashes, `_`, `^`, quotes and dashes. Inside a fence the source arrives as typed.
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
      caption: { type: String },

      align: { type: String },

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
    this._darkMode = new DarkMode(this)
  }

  _typeset(source, fenced) {
    try {
      this._markup = renderToString(source, {
        displayMode: true,
        /*
          The hidden MathML copy is why this block writes no aria-label: a screen reader announces
          the expression as mathematics rather than as TeX source.
        */
        output: 'htmlAndMathml',
        /*
          KaTeX's other answer to bad input is to print the source in red where the formula should
          be, which says nothing about what is wrong with it.
        */
        throwOnError: true,
        /*
          Macros are the one piece of state a render leaves behind: `\gdef` writes into this object,
          so a shared one would carry a definition into whatever is typeset next.
        */
        macros: {}
        // -> `trust` is left at its default: it gates \href, \url and \includegraphics, which put a
        //    link or a remote image into the page from inside TeX.
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
