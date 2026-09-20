import { LitElement, html, css } from 'lit'
import { unsafeSVG } from 'lit/directives/unsafe-svg.js'
import { drawioToSvg } from './mxgraph.js'
import { readFencedSource } from '../shared/body.js'
import { diagramStyles } from '../shared/diagram-image.js'
import { explainEmptySource, explainSourceFailure } from '../shared/figure.js'
import { renderError } from '../shared/render.js'
import { captionStyles, errorBox } from '../shared/styles.js'
import { DarkMode } from '../shared/theme.js'

export class BlockDrawioElement extends LitElement {
  /**
   * Read out of the source text at build time rather than by importing the module, so every value
   * must stay a plain literal.
   */
  static definition = {
    block: 'drawio',
    name: 'draw.io Diagram',
    description: 'Draws a draw.io/diagrams.net diagram from its XML, read-only.',
    icon: 'tabler:vector',
    /*
      Fenced so the XML arrives as typed, rather than with `--` turned into a dash or a `#`-led line
      read as a heading. More than one box on purpose: inserting the block should show a shape, a
      decision and an edge, not leave the author wondering whether it draws anything.
    */
    template: `\`\`\`drawio
<mxGraphModel>
  <root>
    <mxCell id="0" />
    <mxCell id="1" parent="0" />
    <mxCell id="2" value="Start" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
      <mxGeometry x="40" y="40" width="120" height="60" as="geometry" />
    </mxCell>
    <mxCell id="3" value="Ready?" style="rhombus;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;" vertex="1" parent="1">
      <mxGeometry x="220" y="30" width="120" height="80" as="geometry" />
    </mxCell>
    <mxCell id="4" style="edgeStyle=orthogonalEdgeStyle;html=1;" edge="1" source="2" target="3" parent="1">
      <mxGeometry relative="1" as="geometry" />
    </mxCell>
  </root>
</mxGraphModel>
\`\`\``,
    props: [
      {
        name: 'caption',
        type: 'string',
        label: 'Caption',
        hint: 'Shown under the diagram.'
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

  /*
    `diagramStyles` is shared with the remote-diagram blocks for the same reason -- a draw.io
    diagram's colours are chosen against draw.io's own white canvas, so drawing it straight onto a
    dark page would leave dark text unreadable and strokes with nothing to contrast against.
  */
  static get styles() {
    return [
      errorBox,
      captionStyles,
      diagramStyles,
      css`
        .diagram {
          max-width: 100%;
        }

        svg {
          display: block;
          max-width: 100%;
          height: auto;
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
    this.align = 'left'
    this._svg = ''
    this._error = ''
    this._fenced = false
    this._darkMode = new DarkMode(this)
  }

  /**
   * Async because a compressed `<mxfile>`/`<diagram>` body decodes through a native
   * `DecompressionStream`, which is stream-only.
   */
  async _draw() {
    const { source, fenced } = readFencedSource(this)
    this._fenced = fenced
    if (!source) {
      this._error = explainEmptySource('diagram')
      return
    }
    try {
      const { svg } = await drawioToSvg(source)
      this._svg = svg
      this._error = ''
    } catch (err) {
      this._svg = ''
      this._error = explainSourceFailure('diagram could not be drawn', err, this._fenced)
    }
  }

  firstUpdated() {
    // -> Kept on the instance so a test can await the draw finishing; Lit itself ignores what
    //    firstUpdated returns. `_ready` is the convention `shared/diagram-image.js` uses too.
    this._ready = this._draw()
  }

  render() {
    if (this._error) {
      return renderError(this._error)
    }
    if (!this._svg) {
      return null
    }
    return html`
      <div class="diagram ${this.align === 'center' ? 'is-center' : ''}">
        <div class="sheet">${unsafeSVG(this._svg)}</div>
        ${this.caption ? html`<div class="caption">${this.caption}</div>` : null}
      </div>
    `
  }
}

window.customElements.define('block-drawio', BlockDrawioElement)
