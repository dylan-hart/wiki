import { LitElement, css, html } from 'lit'

import { readFencedSource } from './body.js'
import { explainEmptySource } from './figure.js'
import { renderError } from './render.js'
import { captionStyles, errorBox } from './styles.js'
import { DarkMode } from './theme.js'
import { MAX_DIAGRAM_URL_LENGTH, explainUrlTooLarge } from './url-limit.js'

/**
 * The skeleton of a block that draws a diagram by packing its source into a remote server's URL --
 * `block-kroki` and `block-plantuml`.
 *
 * The two are one block with two encoders: after normalising the product names, some 257 of their
 * lines were identical (BLK-F3 / INFRA-F4) -- the styles, the props, the body read, the URL-length
 * guard, the failure explanation and the frame. What differs is the encoding and the shape of the
 * address it goes into, which is what `_url()` is for.
 *
 * A subclass writes:
 *
 * - `_url(source)` -- the address the drawing is fetched from, async because encoding goes through
 *   `CompressionStream`. Build it off `_serverBase()` and `_imageFormat()` rather than reading the
 *   props directly.
 * - `_defaultServer()` -- the server drawn through when the prop is left empty. Also what the
 *   constructor starts `server` at.
 * - `_fenceName()` -- the fence language the block reads, for the empty-body message.
 * - `_alt()` -- what the drawing is called for a reader who cannot see it.
 *
 * and may override:
 *
 * - `_explainBody(response)` -- a provider-specific reason read off the second request's response
 *   (`block-plantuml`'s `X-PlantUML-Diagram-Error` header). Return `null` to fall through to the
 *   status.
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

export class DiagramImageElement extends LitElement {
  static styles = [errorBox, captionStyles, diagramStyles]

  static properties = {
    /**
     * Server to draw with
     * @type {string}
     */
    server: { type: String },

    /**
     * Image format to ask the server for, `svg` or `png`
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
   * The server drawn through when the prop is left empty.
   *
   * @abstract
   */
  _defaultServer() {
    return ''
  }

  /** The server to draw through: what was asked for, trimmed, without its trailing slashes. */
  _serverBase() {
    return (this.server?.trim() || this._defaultServer()).replace(/\/+$/, '')
  }

  /** The format to ask the server for -- `png` only when it was asked for by name. */
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
   * The address the drawing is fetched from.
   *
   * @abstract
   */
  async _url() {
    return ''
  }

  /**
   * A reason for the failure read off the response itself, or null for a server that gives none.
   *
   * `_explain()` calls this with the second request's `Response`; the base implementation gives no
   * reason and so declares no parameter, while an overriding subclass takes it as its one argument
   * (`block-plantuml` reads the `X-PlantUML-Diagram-Error` header off it).
   */
  _explainBody() {
    return null
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

  /**
   * Say what went wrong, having been told only that the image did not load.
   *
   * Not the case of a diagram the server cannot read: asked for an image, these servers answer with
   * an image saying so, and a browser draws it whatever status came with it — so a mistake in the
   * source shows up as the tool's own message where the diagram would have been, which is the best
   * place for it. (Asked for anything else, as a `fetch` is by default, the same server answers `400`
   * and a line of text. The `Accept` header is the difference, and it is another reason these blocks
   * draw through an `img`.)
   *
   * What is left is a server that did not answer, or answered with something that is not an image: a
   * wrong address, a host that cannot be reached from where the reader is, a login page. The request
   * is made a second time to tell those apart, and to give `_explainBody` a response to read. Best
   * effort — kroki.io sends no CORS headers at all, so that second request is refused there and the
   * message below stands as it is. Nothing about drawing a diagram depends on any of it.
   */
  async _explain(url) {
    // -> Resolved against the page, since a server may perfectly well be a path on this wiki
    const absolute = new URL(url, window.location.href)
    this._error = `The diagram could not be drawn by ${absolute.origin}.`
    try {
      const response = await fetch(absolute)
      const reason = this._explainBody(response)
      if (reason) {
        this._error = reason
      } else if (!response.ok) {
        this._error = `The server answered ${response.status} ${response.statusText} for this diagram.`
      }
    } catch {
      // -> Unreachable, blocked, or simply not the server it was taken for; the message says as much
      this._error += ' Check the server address, and that the page may reach it.'
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
   * Encodes the source and, if the result fits, draws it -- the async continuation of
   * `firstUpdated()`, split out because encoding goes through the async `CompressionStream`.
   */
  async _draw(source) {
    const url = await this._url(source)
    /*
      A pre-flight guard, not a reaction to the request that would otherwise follow: without it, a
      diagram whose encoded URL outgrows what a server or reverse proxy accepts fails only once the
      browser tries to load the `img` below, surfacing as `_explain()`'s generic "could not be
      drawn" message with no hint that size is the actual problem. Checking the string's own length
      here catches it before any request is made, with an explanation the vague network failure
      never gave.
    */
    if (url.length > MAX_DIAGRAM_URL_LENGTH) {
      this._error = explainUrlTooLarge(url.length)
      return
    }
    this._src = url
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
            @error="${() => this._explain(this._src)}" />
        </div>
        ${this.caption ? html`<div class="caption">${this.caption}</div>` : null}
      </div>
    `
  }
}
