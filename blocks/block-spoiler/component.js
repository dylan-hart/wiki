import { LitElement, html, css } from 'lit'
import { DarkMode } from '../shared/theme.js'

/*
  Tabler `eye-off`, pasted verbatim from frontend/src/assets/icons.generated.js (OpenProject #2875 --
  blocks.md's ground rules: "Material path SVGs (..., eye-off, ...) -> Tabler"). Stroke rather than
  fill, same as every other Tabler glyph in the app.
*/
const EYE_OFF_SVG = html`
  <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" data-icon="tabler:eye-off">
    <g fill="none" stroke="currentColor" stroke-width="1.5">
      <path d="M10.585 10.587a2 2 0 0 0 2.829 2.828" />
      <path
        d="M16.681 16.673A8.7 8.7 0 0 1 12 18q-5.4 0-9-6q1.908-3.18 4.32-4.674m2.86-1.146A9 9 0 0 1 12 6q5.4 0 9 6q-1 1.665-2.138 2.87M3 3l18 18" />
    </g>
  </svg>
`

/**
 * Block Spoiler
 */
export class BlockSpoilerElement extends LitElement {
  /**
   * Metadata for the admin area and the editor's block picker. Collected at build time into
   * `compiled/blocks.manifest.json`, which the server reads to register the block. Values must be
   * plain literals. See `props` in `block-index` for what the picker does with that list.
   */
  static definition = {
    block: 'spoiler',
    name: 'Spoiler',
    description: 'Hides content behind a cover until it is clicked.',
    icon: 'tabler:eye-off',
    template: 'The content to hide.',
    props: [
      {
        name: 'label',
        type: 'string',
        label: 'Label',
        hint: 'Heading on the cover.',
        default: 'Spoiler'
      },
      {
        name: 'hint',
        type: 'string',
        label: 'Hint',
        hint: 'Line under the label.',
        default: 'Click to show content'
      }
    ]
  }

  static get styles() {
    return css`
      :host {
        display: block;
      }

      /*
        The content is laid out either way and only hidden from view, so the box is exactly as tall
        covered as it is revealed and nothing below it moves when a reader opens it. Hiding it by
        visibility is what does that: display:none would collapse the box, and a blur or a mask leaves
        the text on screen for anyone who looks closely enough at the pixels.
      */
      .spoiler {
        position: relative;
        margin-bottom: 16px;
        min-height: 76px;
        padding: 16px 20px;
        border: 1px solid var(--block-border);
        border-radius: var(--block-radius);
        /* -> Covered is the tint (matches an unrevealed "well"); revealed is the card colour */
        background-color: var(--block-tint-bg);
      }
      .spoiler:not(.is-covered) {
        background-color: var(--block-bg);
      }
      .spoiler.is-covered .content {
        visibility: hidden;
      }

      /*
        Two opposite corner marks, Ledger only. Same aria-hidden four-gradient technique as
        block-infobox / block-tabs.
      */
      .marks {
        display: var(--block-corner-marks);
        position: absolute;
        inset: -5px;
        pointer-events: none;
        background:
          linear-gradient(var(--block-mark-color), var(--block-mark-color)) 0 0 / 7px 1px no-repeat,
          linear-gradient(var(--block-mark-color), var(--block-mark-color)) 0 0 / 1px 7px no-repeat,
          linear-gradient(var(--block-mark-color), var(--block-mark-color)) 100% 100% / 7px 1px
            no-repeat,
          linear-gradient(var(--block-mark-color), var(--block-mark-color)) 100% 100% / 1px 7px
            no-repeat;
      }

      .cover {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 2px;
        width: 100%;
        padding: 8px;
        border: 0;
        border-radius: var(--spoiler-hover-radius);
        background-color: transparent;
        color: var(--spoiler-cover-fg);
        font: inherit;
        text-align: center;
        cursor: pointer;
        transition: background-color 0.15s ease;
      }
      .cover:hover {
        background-color: var(--spoiler-hover-bg);
      }
      .cover:focus-visible {
        outline: var(--spoiler-focus-ring);
        outline-offset: -4px;
      }

      .label {
        color: var(--spoiler-label-fg);
        font-weight: var(--spoiler-label-weight, 500);
        font-size: 14px;
        letter-spacing: 0.02em;
      }

      .hint {
        color: var(--spoiler-hint-fg);
        font: var(--spoiler-hint-font);
        letter-spacing: var(--spoiler-hint-tracking);
        text-transform: var(--spoiler-hint-transform);
      }
    `
  }

  static get properties() {
    return {
      /**
       * Heading on the cover
       * @type {string}
       */
      label: { type: String },

      /**
       * Line under the label
       * @type {string}
       */
      hint: { type: String },

      // Internal Properties
      _covered: { state: true }
    }
  }

  constructor() {
    super()
    this.label = 'Spoiler'
    this.hint = 'Click to show content'
    this._covered = true
    // -> Puts `dark` on this element for the styles above to key off
    this._darkMode = new DarkMode(this)
  }

  /**
   * Drop the outermost margins of the content, the way `block-tabs` does: the box supplies the
   * padding, and a heading adding its own on top of it would push the cover's text off centre.
   */
  _trimEdgeMargins() {
    this.firstElementChild?.style.setProperty('margin-top', '0')
    this.lastElementChild?.style.setProperty('margin-bottom', '0')
  }

  connectedCallback() {
    super.connectedCallback()
    this._trimEdgeMargins()
  }

  /**
   * Reveals the content and, since the cover button is about to unmount rather than stay focused,
   * moves focus onto the (now-visible) content itself so a screen reader announces something rather
   * than silently dropping focus back to the document body.
   */
  async _reveal() {
    this._covered = false
    await this.updateComplete
    this.shadowRoot.getElementById('content')?.focus()
  }

  render() {
    return html`
      <div class="spoiler ${this._covered ? 'is-covered' : ''}">
        <i class="marks" aria-hidden="true"></i>
        <div class="content" id="content" tabindex="-1"><slot></slot></div>
        ${
          this._covered
            ? html`
                <button
                  type="button"
                  class="cover"
                  aria-expanded="${!this._covered}"
                  aria-controls="content"
                  @click="${() => this._reveal()}">
                  ${EYE_OFF_SVG}
                  <span class="label">${this.label}</span>
                  <span class="hint">${this.hint}</span>
                </button>
              `
            : null
        }
      </div>
    `
  }
}

window.customElements.define('block-spoiler', BlockSpoilerElement)
