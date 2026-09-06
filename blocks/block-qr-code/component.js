import { LitElement, html, css } from 'lit'
import { unsafeSVG } from 'lit/directives/unsafe-svg.js'
import { renderSVG } from 'uqr'
import { renderError } from '../shared/render.js'
import { errorBox } from '../shared/styles.js'
import { DarkMode } from '../shared/theme.js'
import { I18n } from '../shared/i18n.js'

/**
 * Block QR Code
 */
export class BlockQrCodeElement extends LitElement {
  /**
   * Metadata for the admin area and the editor's block picker. Collected at build time into
   * `compiled/blocks.manifest.json`, which the server reads to register the block. Values must be
   * plain literals. See `props` in `block-index` for what the picker does with that list.
   */
  static definition = {
    block: 'qr-code',
    name: 'QR Code',
    description: 'Shows a QR code for a link or a piece of text.',
    icon: 'tabler:qrcode',
    props: [
      {
        name: 'value',
        type: 'string',
        label: 'Content',
        hint: 'Text or URL to encode. The address of this page when left empty.'
      },
      {
        name: 'size',
        type: 'number',
        label: 'Size',
        hint: 'Width of the code in pixels.',
        default: 180
      },
      {
        name: 'caption',
        type: 'string',
        label: 'Caption',
        hint: 'Shown under the code.'
      }
    ]
  }

  static get styles() {
    return [
      errorBox,
      css`
        :host {
          display: block;
        }

        /* -> The gap below the block. On this element rather than :host: see block-index. */
        .qr {
          margin-bottom: 16px;
          display: inline-flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          padding: 12px;
          border: 1px solid rgba(0, 0, 0, 0.1);
          border-radius: 5px;
          /*
          White in both themes, and padded: a code is read by a camera looking for dark squares on a
          light field, so inverting it for dark mode would make it harder to scan, not easier.
        */
          background-color: #fff;
        }
        :host([dark]) .qr {
          border-color: rgba(255, 255, 255, 0.15);
        }

        /* -> The drawing is sized here, so the box grows by its own padding rather than eating into it */
        .qr svg {
          display: block;
          width: var(--qr-size);
          height: auto;
        }

        .caption {
          max-width: var(--qr-size);
          color: #424242;
          font-size: 0.8em;
          text-align: center;
          overflow-wrap: anywhere;
        }

        /*
        Standard offscreen-clip technique: present to assistive tech and to a "select all" copy, absent
        from the rendered layout. display: none would pull it out of the accessibility tree too, which
        is the one thing this element exists to avoid -- role="img" below collapses the .qr subtree out
        of the accessible-name computation, so this is the only place the encoded value is exposed.
      */
        .visually-hidden {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0, 0, 0, 0);
          white-space: nowrap;
          border: 0;
        }

        .error {
          margin-bottom: 16px;
        }
      `
    ]
  }

  static get properties() {
    return {
      /**
       * Text or URL to encode
       * @type {string}
       */
      value: { type: String },

      /**
       * Width of the code in pixels
       * @type {number}
       */
      size: { type: Number },

      /**
       * Text shown under the code
       * @type {string}
       */
      caption: { type: String },

      // Internal Properties
      _svg: { state: true },
      /** True once the value has proven too long to fit — the message itself is resolved in render(). */
      _tooLong: { state: true }
    }
  }

  constructor() {
    super()
    this.value = ''
    this.size = 180
    this.caption = ''
    this._svg = ''
    this._tooLong = false
    // -> Puts `dark` on this element for the styles above to key off
    this._darkMode = new DarkMode(this)
    this._i18n = new I18n(this)
  }

  /**
   * What the code stands for.
   *
   * An empty `value` means this page, which is the common case — a printed page, or a screen someone
   * wants to carry on their phone. Taken from the address bar rather than built from the site config,
   * so it is the URL the reader is actually looking at, and without the fragment, which points at a
   * place on the page rather than at the page.
   */
  _encoded() {
    return this.value?.trim() || `${window.location.origin}${window.location.pathname}`
  }

  /**
   * Whether the encoded value is a fetchable web address, worth exposing as a real, clickable link
   * rather than plain text -- true for the common cases (an explicit URL, or the page-address
   * fallback above), false for arbitrary encoded text (a phone number, a Wi-Fi payload, ...).
   */
  _encodedIsUrl(value) {
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol)
    } catch {
      return false
    }
  }

  connectedCallback() {
    super.connectedCallback()
    try {
      // -> Drawn at a fixed scale and sized by CSS, so the same markup is crisp at any width
      this._svg = renderSVG(this._encoded(), { border: 1, pixelSize: 8 })
    } catch {
      // -> Every symbol size has a ceiling, and a long enough string clears the largest of them
      this._tooLong = true
    }
  }

  render() {
    if (this._tooLong) {
      return renderError(
        this._i18n.t('blocks.qr-code.errors.tooLong', 'This is too long to fit in a QR code.')
      )
    }
    const size = `${Math.min(Math.max(Number(this.size) || 180, 80), 600)}px`
    const encoded = this._encoded()
    /*
      role="img" + a short, fixed aria-label is deliberate over labelling the code with the encoded
      value itself: `encoded` can be a multi-hundred-character URL, which would make for an unusable
      accessible name. The actual value is exposed separately below instead -- as a real link when it
      is one, so a screen-reader or keyboard user can also *use* it rather than just hear it read out.
    */
    return html`
      <div class="qr" role="img" aria-label="QR code" style="--qr-size: ${size}">
        ${unsafeSVG(this._svg)}
        ${
          this._encodedIsUrl(encoded)
            ? html`<a class="visually-hidden" href="${encoded}">${encoded}</a>`
            : html`<span class="visually-hidden">${encoded}</span>`
        }
        ${this.caption ? html`<div class="caption">${this.caption}</div>` : null}
      </div>
    `
  }
}

window.customElements.define('block-qr-code', BlockQrCodeElement)
