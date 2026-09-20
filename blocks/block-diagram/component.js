import { LitElement, html, css } from 'lit'
import { unsafeSVG } from 'lit/directives/unsafe-svg.js'
import mermaid from 'mermaid'
import { readFencedSource } from '../shared/body.js'
import { explainEmptySource, explainSourceFailure } from '../shared/figure.js'
import { renderError } from '../shared/render.js'
import { captionStyles, errorBox } from '../shared/styles.js'
import { DarkMode } from '../shared/theme.js'

/**
 * Mermaid writes the SVG's id into the CSS it embeds in it, so two diagrams sharing an id would
 * style each other. A counter rather than a random name keeps a run of them readable in the
 * inspector.
 */
let drawingCount = 0

/**
 * `initialize` configures the library globally, not the call, so two diagrams asking for different
 * themes would both be drawn in whichever was set last. Queued, each has the library to itself from
 * configuring it to being handed back an SVG.
 */
let queue = Promise.resolve()

function drawInTurn(config, id, source) {
  const drawing = queue.then(() => {
    mermaid.initialize(config)
    return mermaid.render(id, source)
  })
  // -> Whether it worked or not, since a diagram that could not be drawn must not hold up the rest
  queue = drawing.then(
    () => {},
    () => {}
  )
  return drawing
}

export class BlockDiagramElement extends LitElement {
  /**
   * Read out of the source text at build time rather than by importing the module, so every value
   * must stay a plain literal.
   */
  static definition = {
    block: 'diagram',
    /*
      Named after the engine, as block-kroki and block-plantuml are: "Diagram" would read as a
      catch-all beside them, when this block draws exactly one syntax.
    */
    name: 'Mermaid',
    description: 'Draws a Mermaid diagram — flowchart, sequence, class, state, ER, gantt and more.',
    icon: 'tabler:sitemap',
    /*
      Fenced, so markdown cannot get at the source first: the typographer turns `--` into a dash, an
      indented line reads as a code block, and `%%` comments and `#` labels are claimed as structure.
    */
    template: `\`\`\`mermaid
flowchart LR
  A[Start] --> B{Ready?}
  B -->|Yes| C[Ship it]
  B -->|No| A
\`\`\``,
    props: [
      {
        name: 'caption',
        type: 'string',
        label: 'Caption',
        hint: 'Shown under the diagram.'
      },
      {
        name: 'theme',
        type: 'select',
        label: 'Theme',
        options: ['auto', 'default', 'dark', 'neutral', 'forest'],
        hint: 'auto follows the light or dark theme the reader is using.',
        default: 'auto'
      },
      {
        name: 'align',
        type: 'select',
        label: 'Alignment',
        options: ['left', 'center'],
        default: 'left'
      }
    ]
  }

  static get styles() {
    return [
      errorBox,
      captionStyles,
      css`
        :host {
          display: block;
        }

        /* -> Not on :host: the app's margin reset in the page beats a :host rule whatever the
              specificity. */
        .diagram,
        .error {
          margin-bottom: 16px;
        }

        .diagram {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 8px;
        }
        .diagram.is-center {
          align-items: center;
        }

        /*
        Mermaid writes its own max-width onto the SVG, so width is already handled; only the height
        is settled here, so that shrinking to the column keeps the shapes in proportion.
      */
        svg {
          max-width: 100%;
          height: auto;
        }
      `
    ]
  }

  static get properties() {
    return {
      caption: { type: String },

      theme: { type: String },

      align: { type: String },

      _svg: { state: true },
      _error: { state: true }
    }
  }

  constructor() {
    super()
    this.caption = ''
    this.theme = 'auto'
    this.align = 'left'
    this._svg = ''
    this._error = ''
    /*
      Two jobs: the `dark` attribute is what the caption colour keys off, and the callback redraws,
      since mermaid picks its colours as it draws and writes them into the SVG. Only `auto` has
      anything to follow -- a diagram asked for a theme by name keeps it either way.
    */
    this._darkMode = new DarkMode(this, {
      onChange: () => {
        if (this.theme === 'auto' && this._source) {
          this._draw()
        }
      }
    })
    /** Generation guard: a stale drawing must not land on top of a newer one. */
    this._drawing = 0
    this._source = ''
    this._fenced = false
  }

  /**
   * `auto` cannot be answered in CSS off the `dark` attribute the way every other block answers it:
   * mermaid picks its colours while it draws and writes them into the SVG.
   */
  _theme() {
    if (this.theme && this.theme !== 'auto') {
      return this.theme
    }
    return this._darkMode.isDark ? 'dark' : 'default'
  }

  async _draw() {
    const drawing = ++this._drawing
    const config = {
      startOnLoad: false,
      // -> A page is authored by whoever may edit it, so the text in a diagram is treated as text:
      //    HTML in a label is escaped and `click` directives do nothing
      securityLevel: 'strict',
      // -> Mermaid's own answer to a broken diagram is to append a drawing of a bomb to the body,
      //    outside this element and past the page's styling. The message below is this block's job.
      suppressErrorRendering: true,
      theme: this._theme(),
      // -> The page's own font, so a diagram reads as part of the text around it. Mermaid measures
      //    its labels in the same font, so the boxes come out the right size for it.
      fontFamily: 'inherit'
    }
    try {
      const { svg } = await drawInTurn(config, `block-diagram-${++drawingCount}`, this._source)
      // -> A theme toggle can start a second drawing while this one is still going
      if (drawing !== this._drawing) {
        return
      }
      this._svg = svg
      this._error = ''
    } catch (err) {
      if (drawing !== this._drawing) {
        return
      }
      this._svg = ''
      /*
        Mermaid says what it could not read and where; the fence is the other half, because a
        diagram that renders everywhere else is nearly always a source markdown got to first.
      */
      this._error = explainSourceFailure('diagram could not be drawn', err, this._fenced)
    }
  }

  firstUpdated() {
    const { source, fenced } = readFencedSource(this)
    this._fenced = fenced
    this._source = source
    if (!this._source) {
      this._error = explainEmptySource('diagram')
      return
    }
    this._draw()
  }

  render() {
    if (this._error) {
      return renderError(this._error)
    }
    return html`
      <div class="diagram ${this.align === 'center' ? 'is-center' : ''}">
        ${unsafeSVG(this._svg)}
        ${this.caption ? html`<div class="caption">${this.caption}</div>` : null}
      </div>
    `
  }
}

window.customElements.define('block-diagram', BlockDiagramElement)
