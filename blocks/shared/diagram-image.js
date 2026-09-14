import { LitElement, css, html } from 'lit'

import { readFencedSource } from './body.js'
import { explainEmptySource } from './figure.js'
import { renderError } from './render.js'
import { getSiteId } from './site.js'
import { captionStyles, errorBox } from './styles.js'
import { DarkMode } from './theme.js'

/**
 * The skeleton of a block that draws a diagram by POSTing its source to this site's Kroki/PlantUML
 * proxy and turning the returned image bytes into a picture -- `block-kroki` and `block-plantuml`.
 *
 * The two are one block with two engines: after normalising the product names, some 257 of their
 * lines were identical (BLK-F3 / INFRA-F4) -- the styles, the props, the body read and the frame.
 * What differs is which engine the proxy renders against and, for Kroki only, which of its languages
 * the source is written in -- which is what `_engine()`/`_extraBody()` are for.
 *
 * Formerly a GET-URL transport: each block deflated its source into a remote server's URL and drew
 * it with a bare `<img src>`, with an 8,000-character pre-flight guard
 * (`blocks/shared/url-limit.js`, deleted) against the size that transport could reliably carry. That
 * guard, the deflate/base64 encoders, and the "ask the same URL again to explain a failed `<img>`
 * load" dance are gone, fully replaced (OpenProject task 3229, no fallback to the old path): this now
 * POSTs the raw source to `POST /_api/sites/:siteId/diagrams/render` (OpenProject task 3228) and
 * reads back either the image bytes or a JSON `{ message }` explaining why there are none, the same
 * `body?.message || <status fallback>` convention `block-live-data/component.js#_poll` already uses
 * for its own site-scoped POST.
 *
 * A subclass writes:
 *
 * - `_engine()` -- which proxy engine draws this block's source: `'kroki'` or `'plantuml'`.
 * - `_extraBody(source)` -- extra fields folded into the POST body alongside `engine`/`source`/
 *   `format`. Kroki's `diagramType` (which of Kroki's languages `source` is written in) is the one
 *   user today; PlantUML needs none, so the base implementation returns `{}`.
 * - `_defaultServer()` -- the block's own `server` prop's default value, shown in the editor. Kept
 *   for that prop's own sake only: which server the proxy actually renders against is resolved
 *   server-side, from the site's own block config (`backend/models/diagramProxy.ts#resolveServer`),
 *   never from a caller-supplied value -- an already-flagged gap (Epic 3183's own description) this
 *   task does not close, only avoids widening.
 * - `_fenceName()` -- the fence language the block reads, for the empty-body message.
 * - `_alt()` -- what the drawing is called for a reader who cannot see it.
 *
 * and may override:
 *
 * - `_emptySourceMessage()` -- to add to the empty-body message; wrap `super`'s rather than retype
 *   it.
 *
 * Deliberately NOT here: `static definition`. It has to stay a plain object literal in each block's
 * own `component.js`, because the build's manifest step, `scripts/check-locale-keys.mjs` and
 * `definitions.test.js` all read it out of the source text rather than by importing the module.
 */

/**
 * The sheet a remote drawing sits on, and the column it sits in.
 *
 * `block-drawio` adopts this too: it draws its SVG inline rather than fetching an image, but the box
 * around it is the same one, for the same reason.
 */
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

/** How many bytes are turned into base64 characters at a time in `_toDataUrl` -- spreading a whole
 *  diagram into `String.fromCharCode` at once overflows the stack somewhere in the tens of thousands
 *  of bytes, the same reason `block-kroki`'s old GET encoder chunked its own base64 pass. */
const DATA_URL_CHUNK_SIZE = 0x8000

export class DiagramImageElement extends LitElement {
  static styles = [errorBox, captionStyles, diagramStyles]

  static properties = {
    /**
     * Server to draw with. No longer read by `_draw()` itself -- see the class comment's
     * `_defaultServer()` entry.
     * @type {string}
     */
    server: { type: String },

    /**
     * Image format to ask the proxy for, `svg` or `png`
     * @type {string}
     */
    format: { type: String },

    /**
     * Text shown under the diagram
     * @type {string}
     */
    caption: { type: String },

    /**
     * Where the diagram sits in the column, `left` or `center`
     * @type {string}
     */
    align: { type: String },

    // Internal Properties
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

  /**
   * The block's own `server` prop's default value, shown in the editor.
   *
   * @abstract
   */
  _defaultServer() {
    return ''
  }

  /** The format to ask the proxy for -- `png` only when it was asked for by name. */
  _imageFormat() {
    return this.format === 'png' ? 'png' : 'svg'
  }

  /**
   * The fence language the block reads, for the empty-body message.
   *
   * @abstract
   */
  _fenceName() {
    return ''
  }

  /** What the drawing is called for a reader who cannot see it. The caption when there is one. */
  _alt() {
    return this.caption || 'diagram'
  }

  /** Shown in place of the diagram when the block's body is empty. */
  _emptySourceMessage() {
    return explainEmptySource('diagram', { fence: this._fenceName() })
  }

  /**
   * Which proxy engine renders this block's source: `'kroki'` or `'plantuml'`.
   *
   * @abstract
   */
  _engine() {
    return ''
  }

  /**
   * Extra fields folded into the POST body alongside `engine`/`source`/`format`. Kroki's own
   * `diagramType` is the one user today; PlantUML needs none.
   */
  _extraBody() {
    return {}
  }

  /**
   * Catch a drawing that came out with no size at all.
   *
   * An SVG carrying a `viewBox` and no `width` has a shape but no size, and a box that shrinks to fit
   * its contents has nothing to resolve against — so the picture lays out at zero and the block draws
   * an empty white square. d2, pikchr, blockdiag and seqdiag write their SVG that way; graphviz,
   * mermaid, ditaa and most of the rest give theirs a size and are left alone.
   *
   * Read after the load rather than guessed at beforehand, since the file itself cannot be inspected:
   * the server it came from need not allow this page to fetch it. Both measurements are needed — a
   * block inside a closed spoiler or an unselected tab measures zero throughout, and is not this.
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
    // -> Not awaited: Lit does not wait on firstUpdated's return value, and there is nothing here
    //    that needs to block it. Kept on the instance so a test can await the draw finishing.
    this._ready = this._draw(source)
  }

  /**
   * POSTs the source to this site's diagram proxy (`POST /_api/sites/:siteId/diagrams/render`,
   * OpenProject task 3228) and, on success, turns the returned image bytes into a `data:` URL the
   * `<img>` below draws with no request of its own -- the async continuation of `firstUpdated()`.
   *
   * On failure, reads the proxy's own JSON `{ message }` (`helpers/errorHandler.ts#apiErrorHandler`)
   * directly rather than re-deriving an explanation from the status line, falling back to one only
   * when the body carries no usable message -- the same convention
   * `block-live-data/component.js#_poll` uses for its own site-scoped POST.
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
   * The rendered image, as a `data:` URL -- not `URL.createObjectURL`, which jsdom (this workspace's
   * test environment) does not implement (mirrors `shared/compress.js`'s identical note about
   * `Blob.prototype.stream`), and which would need an explicit revoke on disconnect that a `data:`
   * URL needs none of.
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
      Nothing at all until the URL exists, which is the first thing `firstUpdated` does — and it runs
      after this. An `img` rendered without one carries `src=""`, which a browser resolves to the page
      itself, fetches, fails to read as an image, and reports as a failed diagram.
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
