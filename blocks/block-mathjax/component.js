import { LitElement, html, css } from 'lit'
import { unsafeSVG } from 'lit/directives/unsafe-svg.js'
import { mathjax } from '@mathjax/src/js/mathjax.js'
import { TeX } from '@mathjax/src/js/input/tex.js'
import { SVG } from '@mathjax/src/js/output/svg.js'
import { liteAdaptor } from '@mathjax/src/js/adaptors/liteAdaptor.js'
import { RegisterHTMLHandler } from '@mathjax/src/js/handlers/html.js'
import { MathJaxNewcmFont } from '@mathjax/mathjax-newcm-font/js/svg.js'
import { MathJaxMhchemFontExtension } from '@mathjax/mathjax-mhchem-font-extension/js/svg.js'
/*
  Side-effect imports: each configuration registers itself under its name, and `PACKAGES` below
  switches it on. MathJax's "all packages" set, less three. `html` puts markup into the page from
  inside TeX, which is not what a formula is for; `noerrors` and `noundefined` each answer a mistake
  by drawing something, and without them the error reaches the panel in `render` instead. `require`
  and `autoload` fetch a package the moment TeX asks for one, which a single bundled file served
  from /_blocks cannot do.
*/
import '@mathjax/src/js/input/tex/base/BaseConfiguration.js'
import '@mathjax/src/js/input/tex/action/ActionConfiguration.js'
import '@mathjax/src/js/input/tex/ams/AmsConfiguration.js'
import '@mathjax/src/js/input/tex/amscd/AmsCdConfiguration.js'
import '@mathjax/src/js/input/tex/bbox/BboxConfiguration.js'
import '@mathjax/src/js/input/tex/boldsymbol/BoldsymbolConfiguration.js'
import '@mathjax/src/js/input/tex/braket/BraketConfiguration.js'
import '@mathjax/src/js/input/tex/bussproofs/BussproofsConfiguration.js'
import '@mathjax/src/js/input/tex/cancel/CancelConfiguration.js'
import '@mathjax/src/js/input/tex/cases/CasesConfiguration.js'
import '@mathjax/src/js/input/tex/centernot/CenternotConfiguration.js'
import '@mathjax/src/js/input/tex/color/ColorConfiguration.js'
import '@mathjax/src/js/input/tex/colortbl/ColortblConfiguration.js'
import '@mathjax/src/js/input/tex/empheq/EmpheqConfiguration.js'
import '@mathjax/src/js/input/tex/enclose/EncloseConfiguration.js'
import '@mathjax/src/js/input/tex/extpfeil/ExtpfeilConfiguration.js'
import '@mathjax/src/js/input/tex/gensymb/GensymbConfiguration.js'
import '@mathjax/src/js/input/tex/mathtools/MathtoolsConfiguration.js'
import '@mathjax/src/js/input/tex/mhchem/MhchemConfiguration.js'
import '@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js'
import '@mathjax/src/js/input/tex/physics/PhysicsConfiguration.js'
import '@mathjax/src/js/input/tex/textcomp/TextcompConfiguration.js'
import '@mathjax/src/js/input/tex/textmacros/TextMacrosConfiguration.js'
import '@mathjax/src/js/input/tex/unicode/UnicodeConfiguration.js'
import '@mathjax/src/js/input/tex/upgreek/UpgreekConfiguration.js'
import '@mathjax/src/js/input/tex/verb/VerbConfiguration.js'

import { readFencedSource } from '../shared/body.js'
import { explainEmptySource, explainSourceFailure, figureStyles } from '../shared/figure.js'
import { renderError } from '../shared/render.js'
import { captionStyles, errorBox } from '../shared/styles.js'
import { DarkMode } from '../shared/theme.js'
import { DYNAMIC_CHUNKS } from './dynamicChunks.js'

export const PACKAGES = [
  'base',
  'action',
  'ams',
  'amscd',
  'bbox',
  'boldsymbol',
  'braket',
  'bussproofs',
  'cancel',
  'cases',
  'centernot',
  'color',
  'colortbl',
  'empheq',
  'enclose',
  'extpfeil',
  'gensymb',
  'mathtools',
  'mhchem',
  'newcommand',
  'physics',
  'textcomp',
  'textmacros',
  'unicode',
  'upgreek',
  'verb'
]

/**
 * Off the document entirely: the SVG output measures nothing in the DOM — it has the metrics of every
 * glyph in the font it draws with — so a formula is typeset against a document MathJax makes up for
 * itself and handed back as markup. That is what makes it usable from inside a shadow root, which
 * MathJax has no notion of and where its own stylesheet in the page would not reach.
 */
const adaptor = liteAdaptor()
RegisterHTMLHandler(adaptor)

/*
  Some glyph ranges -- extpfeil's extensible arrows, \verb's monospace glyphs, every non-Latin range
  -- ship as files of their own that MathJax fetches the first time a formula needs one. None of the
  `asyncLoad` hooks MathJax ships (`@mathjax/src/js/util/asyncLoad/{esm,node,system}.js`) work for a
  single bundled file in a browser: they assume an import map, a bare-specifier fetch, or `require`.
  `DYNAMIC_CHUNKS` does the real fetch, one literal `import()` per range so the bundler can chunk
  each on its own; this hook only turns MathJax's runtime-computed filename back into that key.
*/
mathjax.asyncLoad = (name) => {
  const key = name.replace(/^.*\//, '').replace(/\.js$/, '')
  const load = DYNAMIC_CHUNKS[key]
  return load
    ? load()
    : Promise.reject(new Error(`block-mathjax: no dynamic glyph chunk registered for "${name}"`))
}

const output = new SVG({
  fontData: MathJaxNewcmFont,
  /*
    Each formula carries its own glyph definitions. A page-wide cache is one hidden `svg` in the
    document that every formula points into, and a reference from inside a shadow root does not
    resolve to it — every letter would come out blank.
  */
  fontCache: 'local'
})

/*
  mhchem's bonds, arrows and brackets live in a font variant the text font has no reason to carry.
  Added up front rather than fetched: MathJax's own build loads it the first time a `\ce` turns up,
  which is the one thing a bundled block cannot do.
*/
output.font.addExtension(MathJaxMhchemFontExtension)

const document_ = mathjax.document('', {
  InputJax: new TeX({
    packages: PACKAGES,
    // -> Handing the error on rather than drawing it: see the panel in `render`
    formatError: (jax, err) => {
      throw err
    }
  }),
  OutputJax: output
})

export class BlockMathjaxElement extends LitElement {
  /**
   * Read out of this source text at build time into `compiled/blocks.manifest.json`, so every value
   * has to stay a plain literal.
   */
  static definition = {
    block: 'mathjax',
    name: 'MathJax',
    description:
      "Typesets a TeX formula, including chemical equations written with mhchem's \\ce and \\pu commands.",
    icon: 'tabler:math-symbols',
    /*
      Fenced because TeX is made of the characters markdown reads as its own: a lone backslash goes
      missing, `_` and `^` open emphasis, `\\` ends a line, and the typographer rewrites quotes and
      dashes. Inside a fence the source arrives as typed.
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
      errorBox,
      captionStyles,
      figureStyles,
      css`
        /*
        The drawing takes the colour of the text around it: MathJax paints its glyphs in currentColor,
        so dark mode needs nothing here — unlike a block that picks its own colours.
      */
        svg {
          display: block;
        }
      `
    ]
  }

  static get properties() {
    return {
      caption: { type: String },
      align: { type: String },
      _svg: { state: true },
      _error: { state: true }
    }
  }

  constructor() {
    super()
    this.caption = ''
    this.align = 'center'
    this._svg = ''
    this._error = ''
    this._darkMode = new DarkMode(this)
  }

  /**
   * `document_.convert()` throws MathJax's "retry" signal (`retryAfter()` in `@mathjax/src`'s
   * `util/Retries.js`) the first time a formula needs a glyph chunk `mathjax.asyncLoad` hasn't
   * fetched — a real `Error` whose `.retry` is the in-flight load, not a typesetting failure.
   * `handleRetriesFor` re-runs the conversion once that load resolves, however many chunks one
   * formula needs, so a single await covers them all.
   */
  async _typeset(source, fenced) {
    try {
      const container = await mathjax.handleRetriesFor(() =>
        document_.convert(source, { display: true })
      )
      const drawing = adaptor.firstChild(container)
      /*
        MathJax's own answer to naming the drawing is a MathML copy alongside it, which needs its
        stylesheet in the page to stay hidden and its speech engine to read well — neither of which a
        block in a shadow root has. The TeX source reads aloud imperfectly, but the drawing carries
        role="img" and an image with no name at all is worse.
      */
      adaptor.setAttribute(drawing, 'aria-label', source)
      this._svg = adaptor.outerHTML(drawing)
      this._error = ''
    } catch (err) {
      this._svg = ''
      this._error = explainSourceFailure('formula could not be typeset', err, fenced)
    }
  }

  firstUpdated() {
    const { source, fenced } = readFencedSource(this)
    if (!source) {
      this._error = explainEmptySource('formula', { source: 'TeX source' })
      return
    }
    // -> Lit ignores firstUpdated's return value; kept on the instance so a test can await the
    //    typeset finishing.
    this._ready = this._typeset(source, fenced)
  }

  render() {
    if (this._error) {
      return renderError(this._error)
    }
    return html`
      <div class="formula ${this.align === 'left' ? 'is-left' : ''}">
        <div class="drawing">${unsafeSVG(this._svg)}</div>
        ${this.caption ? html`<div class="caption">${this.caption}</div>` : null}
      </div>
    `
  }
}

window.customElements.define('block-mathjax', BlockMathjaxElement)
