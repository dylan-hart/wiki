import { LitElement, html, css } from 'lit'
import { unsafeSVG } from 'lit/directives/unsafe-svg.js'
import { drawioToSvg } from './mxgraph.js'
import { DarkMode } from '../shared/theme.js'

/**
 * Block Drawio
 *
 * Draws a draw.io/mxGraph diagram as inline SVG, entirely client-side and read-only — see
 * `mxgraph.js` for the renderer and the reasoning for building one rather than embedding draw.io's
 * own editor or its hosted viewer script. This mirrors `block-diagram`'s Mermaid-at-render approach
 * exactly: the source lives in the block's body, fenced so markdown leaves it alone, and is drawn
 * once, synchronously, when the block first renders.
 */
export class BlockDrawioElement extends LitElement {
  /**
   * Metadata for the admin area and the editor's block picker. Collected at build time into
   * `compiled/blocks.manifest.json`, which the server reads to register the block. Values must be
   * plain literals. See `props` in `block-index` for what the picker does with that list.
   */
  static definition = {
    block: 'drawio',
    name: 'draw.io Diagram',
    description: 'Draws a draw.io/diagrams.net diagram from its XML, read-only.',
    icon: 'genealogy',
    /*
      Fenced for the same reason every diagram block here is: inside a fence the XML arrives exactly
      as it was typed, rather than having `--` turned into a dash or a `#`-led line read as a heading.
      The starter diagram is deliberately more than one box: a reader inserting this block should see
      a shape, a decision, and an edge between them, not wonder whether the block draws anything at
      all.
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

  static get styles() {
    return css`
      :host {
        display: block;
      }

      /* -> The gap below the block. On this element rather than :host: see block-index. */
      .diagram,
      .error {
        margin-bottom: 16px;
      }

      .diagram {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 8px;
        max-width: 100%;
      }
      .diagram.is-center {
        align-items: center;
      }

      /*
        White in both themes, like block-kroki's sheet: a draw.io diagram's own colours are chosen
        against draw.io's own white canvas, and drawing it straight onto a dark page would leave dark
        text unreadable and strokes with no contrast to sit on.
      */
      .sheet {
        max-width: 100%;
        padding: 12px;
        border: 1px solid rgba(0, 0, 0, 0.1);
        border-radius: 5px;
        background-color: #fff;
        overflow-x: auto;
      }
      :host([dark]) .sheet {
        border-color: rgba(255, 255, 255, 0.15);
      }

      svg {
        display: block;
        max-width: 100%;
        height: auto;
      }

      .caption {
        color: #424242;
        font-size: 0.8em;
      }
      :host([dark]) .caption {
        color: rgba(255, 255, 255, 0.7);
      }

      .error {
        color: var(--q-negative, #c10015);
        border: 1px dashed color-mix(in srgb, currentColor 50%, transparent);
        border-radius: 5px;
        padding: 1rem;
        white-space: pre-wrap;
      }
    `
  }

  static get properties() {
    return {
      /**
       * Text shown under the diagram
       * @type {string}
       */
      caption: { type: String },

      /**
       * Where the drawing sits in the column, `left` or `center`
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
    this.align = 'left'
    this._svg = ''
    this._error = ''
    /** Whether the source came out of a fence, read once on first render — see `_draw`. */
    this._fenced = false
    // -> Puts `dark` on this element for the .sheet/.caption styles above to key off
    this._darkMode = new DarkMode(this)
  }

  /**
   * Read the source out of the block's body and draw it. Synchronous, unlike `block-diagram`'s
   * mermaid draw: nothing here is a shared library with global config to serialize behind a queue,
   * so there is nothing to await.
   */
  _draw() {
    const fence = this.querySelector('pre')
    this._fenced = Boolean(fence)
    const source = ((fence ?? this).textContent ?? '').trim()
    if (!source) {
      this._error =
        'This diagram is empty. Its source goes in the body of the block, inside a fenced code block.'
      return
    }
    try {
      const { svg } = drawioToSvg(source)
      this._svg = svg
      this._error = ''
    } catch (err) {
      this._svg = ''
      this._error = `This diagram could not be drawn: ${err.message ?? err}`
      if (!this._fenced) {
        this._error +=
          '\n\nThe source has to go inside a fenced code block, or markdown rewrites it before this block sees it.'
      }
    }
  }

  firstUpdated() {
    this._draw()
  }

  render() {
    if (this._error) {
      return html`<div class="error">${this._error}</div>`
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
