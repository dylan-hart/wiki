import { LitElement, css, html } from 'lit'

import { readFencedSource } from './body.js'
import { explainEmptySource } from './figure.js'
import { renderError } from './render.js'
import { getSiteId } from './site.js'
import { captionStyles, errorBox } from './styles.js'
import { DarkMode } from './theme.js'

/**
 * The skeleton of a block that draws a diagram through this site's Kroki/PlantUML proxy --
 * `block-kroki` and `block-plantuml`.
 *
 * Deliberately NOT here: `static definition`. It has to stay a plain object literal in each block's
 * own `component.js`, because the build's manifest step, `scripts/check-locale-keys.mjs` and
 * `definitions.test.js` all read it out of the source text rather than by importing the module.
 */

/** `block-drawio` adopts this too: its SVG is drawn inline rather than fetched, in the same box. */
export const diagramStyles = css`
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
  }
  .diagram.is-center {
    align-items: center;
  }

  /*
    The drawing sits on white in both themes, padded, the way a QR code does. Most diagram tools draw
    in black on nothing at all, so on a dark page a diagram left to the page's background is black on
    black -- and its own colours, where a diagram has them, are picked to sit on paper.
  */
  .sheet {
    max-width: 100%;
    padding: 12px;
    border: 1px solid rgba(0, 0, 0, 0.1);
    border-radius: 5px;
    background-color: #fff;
    /* -> A diagram wider than the column scrolls rather than shrinking to illegibility */
    overflow-x: auto;
  }
  :host([dark]) .sheet {
    border-color: rgba(255, 255, 255, 0.15);
  }

  img {
    display: block;
    /* -> Its own size, up to the width of the column */
    max-width: 100%;
    height: auto;
  }

  /*
    The fallback for a drawing that has no size of its own: see _measure below. The sheet takes the
    column instead of hugging the picture, which gives the picture a width to scale against -- which
    is what a browser does with any image that has a shape and no size. The height is then bounded,
    since a tall shape scaled to the width of a column runs to several screens, and the drawing is
    fitted inside what that leaves.
  */
  .diagram.is-unsized .sheet {
    align-self: stretch;
  }
  .diagram.is-unsized img {
    width: 100%;
    max-height: 60vh;
    object-fit: contain;
  }
`

/** Spread over a whole diagram's bytes at once, `String.fromCharCode` overflows the stack. */
const DATA_URL_CHUNK_SIZE = 0x8000

export class DiagramImageElement extends LitElement {
  static styles = [errorBox, captionStyles, diagramStyles]

  static properties = {
    /**
     * Shown in the editor, but not what the drawing is rendered against: the proxy resolves the
     * server from the site's own block config (`backend/models/diagramProxy.ts#resolveServer`),
     * never from a caller-supplied value.
     */
    server: { type: String },

    format: { type: String },

    caption: { type: String },

    align: { type: String },

    _src: { state: true },
    _unsized: { state: true },
    _error: { state: true }
  }

  constructor() {
    super()
    this.server = this._defaultServer()
    this.format = 'svg'
    this.caption = ''
    this.align = 'left'
    this._src = ''
    this._unsized = false
    this._error = ''
    // -> Puts `dark` on this element for the styles above to key off
    this._darkMode = new DarkMode(this)
  }

  /** @abstract */
  _defaultServer() {
    return ''
  }

  _imageFormat() {
    return this.format === 'png' ? 'png' : 'svg'
  }

  /** @abstract The fence language the block reads. */
  _fenceName() {
    return ''
  }

  _alt() {
    return this.caption || 'diagram'
  }

  _emptySourceMessage() {
    return explainEmptySource('diagram', { fence: this._fenceName() })
  }

  /** @abstract Which proxy engine renders this block's source: `'kroki'` or `'plantuml'`. */
  _engine() {
    return ''
  }

  /** Extra fields folded into the POST body alongside `engine`/`source`/`format`. */
  _extraBody() {
    return {}
  }

  /**
   * An SVG carrying a `viewBox` and no `width` has a shape but no size, and a sheet that shrinks to
   * fit its contents gives it nothing to resolve against — so the picture lays out at zero and the
   * block draws an empty white square.
   *
   * Measured after the load rather than guessed at beforehand, since the file itself cannot be
   * inspected. Both measurements are needed — a block inside a closed spoiler or an unselected tab
   * measures zero throughout, and is not this.
   */
  _measure(img) {
    if (img.clientWidth === 0 && this.renderRoot.querySelector('.sheet')?.clientWidth > 0) {
      this._unsized = true
    }
  }

  firstUpdated() {
    const { source } = readFencedSource(this)
    if (!source) {
      this._error = this._emptySourceMessage()
      return
    }
    // -> Not awaited: Lit ignores firstUpdated's return value. Kept on the instance so a test can
    //    await the draw finishing.
    this._ready = this._draw(source)
  }

  /**
   * The proxy's own JSON `{ message }` explains why a render failed, so it is preferred over
   * re-deriving an explanation from the status line; the status fallback covers only a body that
   * carries no usable message.
   */
  async _draw(source) {
    try {
      const siteId = await getSiteId()
      if (!siteId) {
        throw new Error('Could not determine the current site.')
      }
      const resp = await fetch(`/_api/sites/${siteId}/diagrams/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          engine: this._engine(),
          source,
          format: this._imageFormat(),
          ...this._extraBody()
        })
      })
      if (!resp.ok) {
        const body = await resp.json().catch(() => null)
        throw new Error(
          body?.message || `The server answered ${resp.status} ${resp.statusText} for this diagram.`
        )
      }
      this._src = await this._toDataUrl(resp)
    } catch (err) {
      this._error = err.message || 'This diagram could not be drawn.'
    }
  }

  /**
   * A `data:` URL rather than `URL.createObjectURL`: jsdom (the test environment) does not implement
   * the latter, and an object URL would need an explicit revoke on disconnect.
   */
  async _toDataUrl(response) {
    const contentType =
      response.headers.get('content-type') ||
      (this._imageFormat() === 'png' ? 'image/png' : 'image/svg+xml')
    const bytes = new Uint8Array(await response.arrayBuffer())
    let binary = ''
    for (let i = 0; i < bytes.length; i += DATA_URL_CHUNK_SIZE) {
      binary += String.fromCharCode(...bytes.subarray(i, i + DATA_URL_CHUNK_SIZE))
    }
    return `data:${contentType};base64,${btoa(binary)}`
  }

  render() {
    if (this._error) {
      return renderError(this._error)
    }
    /*
      Nothing at all until the URL exists: an `img` rendered without one carries `src=""`, which a
      browser resolves to the page itself, fetches, fails to read as an image, and reports as a
      failed diagram.
    */
    if (!this._src) {
      return null
    }
    return html`
      <div
        class="diagram ${this.align === 'center' ? 'is-center' : ''} ${
          this._unsized ? 'is-unsized' : ''
        }">
        <div class="sheet">
          <img
            src="${this._src}"
            alt="${this._alt()}"
            @load="${(e) => this._measure(e.target)}"
            @error="${() => {
              this._error = 'This diagram could not be drawn.'
            }}" />
        </div>
        ${this.caption ? html`<div class="caption">${this.caption}</div>` : null}
      </div>
    `
  }
}
