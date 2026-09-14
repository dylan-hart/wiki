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
  Every TeX package the block understands, imported for its side effect: a configuration registers
  itself under its name, and `PACKAGES` below is what then switches it on.

  This is the set MathJax's own "all packages" bundle carries, less three of them. `html` is left out
  because it exists to put HTML into the page from inside TeX — a link, a class, a style attribute —
  which is not what a formula is for. `noerrors` and `noundefined` are left out because both answer a
  mistake by drawing something: the unreadable source in place of the formula, or a black box where a
  macro should have been. Without them the error reaches this file, which has a panel to say so in.

  Nothing here loads anything at run time. `require` and `autoload` are absent for that reason: both
  fetch a package the moment TeX asks for one, which cannot work in a bundle — the block is a single
  file served from /_blocks, with no MathJax install behind it to fetch from.
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

// -> Exported so component.test.js can pin it against the 2.5.x-reachable set audited for
//    Feature 366 / Task 634 without duplicating the list.
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
 * MathJax, set up once for the page.
 *
 * Off the document entirely: the SVG output measures nothing in the DOM — it has the metrics of every
 * glyph in the font it draws with — so a formula can be typeset against a document MathJax makes up
 * for itself and handed back as markup. That is what makes it usable from inside a shadow root, which
 * MathJax has no notion of and where its own stylesheet in the page would not reach.
 */
const adaptor = liteAdaptor()
RegisterHTMLHandler(adaptor)

/*
  Some glyph ranges -- extpfeil's extensible arrows (\xtwoheadrightarrow &c.), \verb's monospace
  glyphs, every non-Latin/accented Unicode range -- ship as files of their own rather than inside the
  font's base bundle, and MathJax fetches one only the first time a formula actually needs it. Doing
  that fetch is `mathjax.asyncLoad`'s job, and none of the hooks MathJax ships one for (see
  `@mathjax/src/js/util/asyncLoad/{esm,node,system}.js`) apply here: the esm one assumes an import
  map or a same-origin relative fetch that still names the range as a bare npm specifier, the node
  one assumes `require`, and this block is a single bundled file running in a browser with neither --
  which is exactly why `\xtwoheadrightarrow` failed before this (OpenProject #3190). `DYNAMIC_CHUNKS`
  in `./dynamicChunks.js` is where the real fetch happens, one literal `import()` per range so Rollup
  can chunk each one on its own; this hook only has to turn MathJax's runtime-computed filename back
  into the matching map entry.
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
    Each formula carries its own glyph definitions. The alternative, one cache for the page, is a
    single hidden `svg` in the document that every formula points into — and a reference from inside a
    shadow root does not resolve to it, so every letter would come out blank.
  */
  fontCache: 'local'
})

/*
  mhchem's bonds, arrows and brackets are glyphs of their own, in a font variant the text font has no
  reason to carry. Added here rather than fetched: MathJax's own build loads this on demand the first
  time a `\ce` turns up, which is the one thing a bundled block cannot do.
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

/**
 * Block MathJax
 */
export class BlockMathjaxElement extends LitElement {
  /**
   * Metadata for the admin area and the editor's block picker. Collected at build time into
   * `compiled/blocks.manifest.json`, which the server reads to register the block. Values must be
   * plain literals. See `props` in `block-index` for what the picker does with that list.
   */
  static definition = {
    block: 'mathjax',
    name: 'MathJax',
    description:
      "Typesets a TeX formula, including chemical equations written with mhchem's \\ce and \\pu commands.",
    icon: 'tabler:math-symbols',
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
    // -> Puts `dark` on this element for the styles above to key off
    this._darkMode = new DarkMode(this)
  }

  /**
   * Typeset the source, or say why it could not be.
   *
   * `document_.convert()` throws MathJax's "retry" signal (`retryAfter()` in `@mathjax/src`'s
   * `util/Retries.js`) the first time a formula needs a dynamic glyph chunk `mathjax.asyncLoad`
   * hasn't fetched yet — a real `Error` whose `.retry` is the in-flight load's promise, not a
   * typesetting failure to report. `mathjax.handleRetriesFor` is what turns that signal into an
   * actual wait: it re-runs the conversion once the load resolves, and keeps doing so for however
   * many chunks one formula ends up needing, so this only has to await it once.
   */
  async _typeset(source, fenced) {
    try {
      const container = await mathjax.handleRetriesFor(() =>
        document_.convert(source, { display: true })
      )
      const drawing = adaptor.firstChild(container)
      /*
        The formula named for a reader who cannot see it. MathJax's own answer to this is a MathML
        copy of the expression alongside the drawing, which needs its stylesheet in the page to stay
        hidden and its speech engine to read well — neither of which a block in a shadow root has. The
        source is what is left, and it is what the author wrote: imperfectly read aloud, but the
        drawing already carries role="img", and an image with no name at all is worse.
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
    // -> Not awaited: Lit does not wait on firstUpdated's return value, and there is nothing here
    //    that needs to block it. Kept on the instance so a test can await the typeset finishing --
    //    see shared/diagram-image.js's identical `_ready` for the two diagram blocks.
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
