import { LitElement, html, css, svg } from 'lit'

import { readFencedSource } from '../shared/body.js'
import { LightboxController, lightboxStyles } from '../shared/lightbox.js'
import { boolean } from '../shared/props.js'
import { renderError } from '../shared/render.js'
import { errorBox } from '../shared/styles.js'
import { DarkMode } from '../shared/theme.js'

const PREVIOUS_SVG = svg`<svg viewBox="0 0 24 24" aria-hidden="true" data-icon="tabler:chevron-left">
  <path fill="none" stroke="currentColor" stroke-width="1.5" d="m15 6l-6 6l6 6" />
</svg>`
const NEXT_SVG = svg`<svg viewBox="0 0 24 24" aria-hidden="true" data-icon="tabler:chevron-right">
  <path fill="none" stroke="currentColor" stroke-width="1.5" d="m9 6l6 6l-6 6" />
</svg>`
const CLOSE_SVG = svg`<svg viewBox="0 0 24 24" aria-hidden="true" data-icon="tabler:x">
  <path fill="none" stroke="currentColor" stroke-width="1.5" d="M18 6L6 18M6 6l12 12" />
</svg>`

const FILES_PREFIX = '/_files/'

/**
 * An address that already says where it points — including the wiki's own `/_` routes, `/_files/`
 * among them.
 */
const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/_)/i

/**
 * Everything else is a path into the file manager, so an author can paste the path the file manager
 * shows without remembering the prefix. `/_` routes are spared that — `/_files/` is one of them, so
 * a path already carrying the prefix is not given a second one.
 */
function resolveSource(value) {
  const address = value.trim()
  if (ABSOLUTE.test(address)) {
    return address
  }
  return FILES_PREFIX + address.replace(/^\/+/, '')
}

/** Alt text for an image: the file name is all a list of addresses carries. */
function labelFor(address) {
  const path = address.split(/[?#]/)[0]
  const name = path.split('/').filter(Boolean).at(-1) ?? address
  try {
    return decodeURIComponent(name)
  } catch {
    // -> A stray `%` in a file name, which is not an escape and not worth failing over
    return name
  }
}

export class BlockGalleryElement extends LitElement {
  /**
   * Read out of the source text at build time rather than by importing the module, so every value
   * must stay a plain literal.
   */
  static definition = {
    block: 'gallery',
    name: 'Image Gallery',
    description: 'Displays a grid of images, each opening full size in a lightbox.',
    icon: 'tabler:photo',
    props: [
      {
        name: 'thumbnail-size',
        type: 'number',
        label: 'Thumbnail Size',
        hint: 'Smallest a thumbnail may be, in pixels. The grid fits as many as the width allows.',
        default: 180
      },
      {
        name: 'fit',
        type: 'select',
        label: 'Thumbnail Fit',
        options: ['cover', 'contain'],
        hint: 'Whether a thumbnail is cropped to fill its tile, or shown whole inside it.',
        default: 'cover'
      },
      {
        name: 'unlock-aspect-ratio',
        type: 'boolean',
        label: 'Unlock Aspect Ratio',
        hint: 'Let each tile take the shape of its image, instead of holding every one square.',
        // -> Stated, so that a toggle switched on and then off again writes nothing into the page
        default: false
      }
    ],
    template: `https://example.com/photo-1.jpg
https://example.com/photo-2.jpg`
  }

  static get styles() {
    return [
      errorBox,
      lightboxStyles,
      css`
        :host {
          display: block;
        }

        /*
        The grid, and the gap below the block. On this element rather than :host: see block-index.

        -> min() rather than the thumbnail size on its own, so a gallery asked for at 300 on a phone
           is one column the width of the phone instead of pushing the page sideways.
      */
        .gallery {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(min(var(--gallery-thumb), 100%), 1fr));
          gap: 8px;
          margin-bottom: 16px;
        }

        .tile {
          position: relative;
          display: block;
          padding: 0;
          border: 1px solid var(--block-border);
          border-radius: var(--gallery-tile-radius);
          overflow: hidden;
          background-color: var(--block-tint-bg);
          aspect-ratio: 1;
          cursor: zoom-in;
        }
        .tile:hover,
        .tile:focus-visible {
          box-shadow: var(--gallery-hover-ring);
          border-color: var(--gallery-hover-border);
        }
        .tile:focus-visible {
          outline: none;
        }

        /*
          Two opposite corner marks, shown on hover/focus only, Ledger only -- blocks.md: "Hover/focus:
          Ledger inset ... + #e4676b corner marks". Same technique as the other board blocks; hidden
          by default and revealed with the ring rather than sized off inset: -5px past the tile's own
          edge, since a gallery tile (unlike a card) has nothing outside itself to draw into.
        */
        .marks {
          display: none;
          position: absolute;
          inset: 0;
          pointer-events: none;
          background:
            linear-gradient(var(--block-mark-color), var(--block-mark-color)) 0 0 / 7px 1px
              no-repeat,
            linear-gradient(var(--block-mark-color), var(--block-mark-color)) 0 0 / 1px 7px
              no-repeat,
            linear-gradient(var(--block-mark-color), var(--block-mark-color)) 100% 100% / 7px 1px
              no-repeat,
            linear-gradient(var(--block-mark-color), var(--block-mark-color)) 100% 100% / 1px 7px
              no-repeat;
        }
        .tile:hover .marks,
        .tile:focus-visible .marks {
          display: var(--gallery-hover-marks);
        }

        /*
        A gallery whose tiles take the shape of their images rather than being held square.

        Dropping the ratio is not enough on its own: a grid item stretches to the height of its row,
        which hands the image back a definite height to be cropped to -- the tallest photo of the row
        deciding the shape of the rest, which is the thing being unlocked. So the row lets go of them
        as well, and the image is left to its own height.
      */
        .gallery.is-unlocked {
          align-items: start;
        }
        .gallery.is-unlocked .tile {
          aspect-ratio: auto;
        }
        .gallery.is-unlocked .tile img {
          height: auto;
        }

        .tile img {
          display: block;
          width: 100%;
          height: 100%;
          object-fit: var(--gallery-fit);
          /* -> The alt text of an image that did not load, which has no room to be centred in */
          font-size: 12px;
          color: var(--block-caption-fg);
          transition: transform 200ms ease;
        }
        /*
          -> Ledger: no transform on hover, corner marks + ring are the affordance instead. Cobalt:
             the existing zoom, --gallery-hover-scale is 1 in Ledger so this is a no-op there too.
        */
        .tile:hover img {
          transform: scale(var(--gallery-hover-scale));
        }
        @media (prefers-reduced-motion: reduce) {
          .tile img {
            transition: none;
          }
          .tile:hover img {
            transform: none;
          }
        }

        /*
        The lightbox's own dialog shell (the full-viewport <dialog>, its backdrop, its fade
        transition, and the clickable .stage) is lightboxStyles, from ../shared/lightbox.js --
        see LightboxController's own doc for why Escape/focus-return/inert-background all come free
        with it, and for the scroll lock (the one thing that isn't). What's left here is this
        block's own chrome drawn over that stage: the prev/next/close buttons and the counter.
      */
        .chrome {
          position: absolute;
          display: flex;
          align-items: center;
          justify-content: center;
          width: var(--gallery-chrome-size);
          height: var(--gallery-chrome-size);
          padding: 0;
          border: var(--gallery-chrome-border);
          border-radius: var(--gallery-chrome-radius);
          background-color: var(--gallery-chrome-bg);
          color: #fff;
          cursor: pointer;
        }
        .chrome:hover {
          background-color: var(--gallery-chrome-hover-bg);
        }
        .chrome:focus-visible {
          outline: 2px solid #fff;
          outline-offset: 2px;
        }
        .chrome svg {
          width: var(--gallery-chrome-icon);
          height: var(--gallery-chrome-icon);
        }

        .chrome.is-close {
          top: 12px;
          right: 12px;
        }
        .chrome.is-previous {
          top: 50%;
          left: 12px;
          transform: translateY(-50%);
        }
        .chrome.is-next {
          top: 50%;
          right: 12px;
          transform: translateY(-50%);
        }

        .counter {
          position: absolute;
          bottom: 16px;
          left: 50%;
          transform: translateX(-50%);
          padding: var(--gallery-counter-pad);
          border-radius: var(--gallery-counter-radius);
          background-color: var(--gallery-counter-bg);
          color: rgb(255 255 255 / 0.85);
          font: var(--gallery-counter-font);
          letter-spacing: var(--gallery-counter-tracking);
          line-height: 1;
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
       * -> Explicit `attribute`: Lit's default lowercases the property name without inserting a
       *    dash, so it would listen for `thumbnailsize` while the block picker writes the literal
       *    `static definition.props[].name` into the page.
       */
      thumbnailSize: { type: Number, attribute: 'thumbnail-size' },

      fit: { type: String },

      /** -> Explicit `attribute`, for the same reason as `thumbnailSize`. */
      unlockAspectRatio: { ...boolean, attribute: 'unlock-aspect-ratio' },

      _images: { state: true }
    }
  }

  constructor() {
    super()
    this.thumbnailSize = 180
    this.fit = 'cover'
    this.unlockAspectRatio = false
    this._images = []
    // -> Puts `dark` on this element for the styles above to key off
    this._darkMode = new DarkMode(this)
    this._lightbox = new LightboxController(this, {
      count: () => this._images.length,
      // -> index -1 is the close case
      onIndexChange: (index) => {
        if (index >= 0) {
          this._preloadNeighbours(index)
        }
      }
    })
  }

  /**
   * Markdown has already run over the body, so the split is on whitespace rather than line endings:
   * lines markdown joined into one paragraph still read as the list they were written as. Images
   * markdown drew for itself are collected too, since `![](photo.jpg)` arrives as an `img` carrying
   * no text at all — but not out of a fence, which markdown has not touched.
   */
  firstUpdated() {
    const { source, fenced } = readFencedSource(this)
    const found = source.split(/\s+/).filter(Boolean).map(resolveSource)
    if (!fenced) {
      for (const image of this.querySelectorAll('img')) {
        found.push(resolveSource(image.getAttribute('src') ?? ''))
      }
    }
    // -> An address markdown both linkified and drew as an image arrives twice, and is one photo
    this._images = [...new Set(found)]
  }

  _preloadNeighbours(index) {
    for (const step of [-1, 1]) {
      const image = new Image()
      image.src = this._images[this._lightbox.wrap(index + step)]
    }
  }

  /**
   * The `<dialog>` is always in the shadow tree, since it is what `showModal` is called on, but its
   * contents wait until it opens: otherwise every gallery on the page fetches a full-size photo the
   * reader may never ask for.
   */
  _renderLightbox() {
    const address = this._images[this._lightbox.index]
    return html`
      <dialog
        class="lightbox"
        aria-label="Image viewer"
        @click=${this._lightbox.onStageClick}
        @keydown=${this._lightbox.onKeydown}
        @close=${this._lightbox.onClose}>
        ${
          address
            ? html`
                <div class="stage">
                  <img src=${address} alt=${labelFor(address)} />
                </div>
                ${
                  this._images.length > 1
                    ? html`
                        <button
                          class="chrome is-previous"
                          type="button"
                          title="Previous image"
                          aria-label="Previous image"
                          @click=${this._lightbox.previous}>
                          ${PREVIOUS_SVG}
                        </button>
                        <button
                          class="chrome is-next"
                          type="button"
                          title="Next image"
                          aria-label="Next image"
                          @click=${this._lightbox.next}>
                          ${NEXT_SVG}
                        </button>
                        <div class="counter">
                          ${this._lightbox.index + 1} / ${this._images.length}
                        </div>
                      `
                    : null
                }
                <!-- -> Focused on opening, so the lightbox is closable from the keyboard straight away -->
                <button
                  class="chrome is-close"
                  type="button"
                  autofocus
                  title="Close"
                  aria-label="Close"
                  @click=${this._lightbox.close}>
                  ${CLOSE_SVG}
                </button>
              `
            : null
        }
      </dialog>
    `
  }

  render() {
    if (this._images.length < 1) {
      return renderError(
        'This gallery is empty. Its images go in the body of the block, one address per line.'
      )
    }

    const size = Number(this.thumbnailSize)
    const style = [
      `--gallery-thumb: ${Number.isFinite(size) && size > 0 ? size : 180}px`,
      `--gallery-fit: ${this.fit === 'contain' ? 'contain' : 'cover'}`
    ].join('; ')

    return html`
      <div class="gallery ${this.unlockAspectRatio ? 'is-unlocked' : ''}" style=${style}>
        ${this._images.map(
          (address, index) => html`
            <button
              class="tile"
              type="button"
              title="Enlarge Image"
              aria-label="View ${labelFor(address)} full size"
              @click=${() => this._lightbox.open(index)}>
              <i class="marks" aria-hidden="true"></i>
              <img src=${address} alt=${labelFor(address)} loading="lazy" decoding="async" />
            </button>
          `
        )}
      </div>
      ${this._renderLightbox()}
    `
  }
}

window.customElements.define('block-gallery', BlockGalleryElement)
