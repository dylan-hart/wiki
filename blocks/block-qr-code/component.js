import { LitElement, html, css } from 'lit'
import { unsafeSVG } from 'lit/directives/unsafe-svg.js'
import { renderSVG } from 'uqr'
import { renderError } from '../shared/render.js'
import { errorBox } from '../shared/styles.js'
import { DarkMode } from '../shared/theme.js'
import { I18n } from '../shared/i18n.js'

export class BlockQrCodeElement extends LitElement {
  /**
   * Read out of the source text at build time rather than by importing the module, so every value
   * has to stay a plain literal.
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

        .qr {
          margin-bottom: 16px;
          display: inline-flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          padding: 12px;
          border: 1px solid var(--block-border);
          border-radius: var(--block-radius);
          /*
          White and padded in every theme: a camera looks for dark squares on a light field, so
          tinting or inverting the code only makes it harder to scan.
        */
          background-color: #fff;
        }

        /* -> Sized on the drawing, so the box grows by its padding rather than eating into it */
        .qr svg {
          display: block;
          width: var(--qr-size);
          height: auto;
        }

        .caption {
          max-width: var(--qr-size);
          color: var(--block-caption-fg);
          font-size: 12.5px;
          text-align: center;
          overflow-wrap: anywhere;
        }

        /*
        Offscreen clip, not display: none -- role="img" on .qr collapses the subtree out of the
        accessible-name computation, so this is the only place the encoded value reaches assistive
        tech, and display: none would drop it from the accessibility tree as well.
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
      value: { type: String },
      size: { type: Number },
      caption: { type: String },
      _svg: { state: true },
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
    this._darkMode = new DarkMode(this)
    this._i18n = new I18n(this)
  }

  /**
   * An empty `value` means this page. Taken from the address bar rather than the site config so it
   * is the URL the reader is actually looking at, minus the fragment, which points at a place on
   * the page rather than at the page.
   */
  _encoded() {
    return this.value?.trim() || `${window.location.origin}${window.location.pathname}`
  }

  /** Only a fetchable web address is worth exposing as a clickable link rather than plain text. */
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
      // -> uqr throws once the string clears the largest symbol size
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
      A short fixed aria-label rather than the encoded value: `encoded` can be a
      multi-hundred-character URL, which makes for an unusable accessible name. The value itself is
      exposed below instead -- as a real link when it is one, so it can be used and not just heard.
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
