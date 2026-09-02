import { LitElement, html, css } from 'lit'

import { boolean } from '../shared/props.js'
import { renderError } from '../shared/render.js'
import { errorBox } from '../shared/styles.js'
import { DarkMode } from '../shared/theme.js'

/** Every Dailymotion host a link can arrive on: the share link, its short form, and the embed itself. */
const HOSTS = /^(?:www\.)?dailymotion\.com$/
const SHORT_HOST = 'dai.ly'

/** What a Dailymotion video id is made of. Length is not checked: that is Dailymotion's to change. */
const ID = /^[A-Za-z0-9]+$/

/**
 * The video a link points at, or null for a link that points at no video.
 *
 * A share link carries the id as the first segment after `/video/`, often followed by a `_`-joined
 * title slug the id itself never contains (`dailymotion.com/video/<id>_some-title`); the short link
 * and the embed's own address carry the bare id. A bare id pasted on its own is taken as one too, the
 * same as `block-youtube` does for a pasted id rather than a link.
 */
function videoId(source) {
  const value = source.trim()
  if (!value) {
    return null
  }
  if (ID.test(value)) {
    return value
  }
  // -> A link written without a scheme is still a link; `new URL` disagrees, so it is given one
  const url = URL.parse(value) ?? URL.parse(`https://${value}`)
  if (!url) {
    return null
  }
  const host = url.hostname.toLowerCase()
  const id =
    host === SHORT_HOST
      ? url.pathname.slice(1).split('/')[0]
      : !HOSTS.test(host)
        ? null
        : /^\/(?:embed\/video|video)\/([^/]+)/.exec(url.pathname)?.[1]

  const bare = id?.split('_')[0]
  return bare && ID.test(bare) ? bare : null
}

/**
 * Block Dailymotion
 *
 * A Dailymotion player, from the address of a video. Nothing is fetched until the frame is scrolled
 * near, and the frame is the only thing here: the player, its controls and everything it does are
 * Dailymotion's, driven by the parameters below.
 */
export class BlockDailymotionElement extends LitElement {
  /**
   * Metadata for the admin area and the editor's block picker. Collected at build time into
   * `compiled/blocks.manifest.json`, which the server reads to register the block. Values must be
   * plain literals. See `props` in `block-index` for what the picker does with that list.
   */
  static definition = {
    block: 'dailymotion',
    name: 'Dailymotion Player',
    description: 'Embeds a Dailymotion video.',
    icon: 'widescreen',
    props: [
      {
        name: 'url',
        type: 'string',
        label: 'Video URL',
        hint: 'Address of the video, as Dailymotion gives it — a dailymotion.com or dai.ly link.',
        required: true
      },
      {
        name: 'width',
        type: 'number',
        label: 'Width',
        hint: 'Width of the player in pixels. Empty fills the width of the page.'
      },
      {
        name: 'height',
        type: 'number',
        label: 'Height',
        hint: 'Height of the player in pixels. Empty keeps the widescreen shape.'
      },
      {
        name: 'autoplay',
        type: 'boolean',
        label: 'Autoplay',
        hint: 'Start as soon as the page is opened. Browsers only allow that muted, so it is.',
        default: false
      },
      {
        name: 'controls',
        type: 'boolean',
        label: 'Show Controls',
        hint: 'Show the play bar over the video.',
        default: true
      },
      {
        name: 'fs',
        type: 'boolean',
        label: 'Allow Fullscreen',
        hint: 'Offer the fullscreen button.',
        default: true
      },
      {
        name: 'loop',
        type: 'boolean',
        label: 'Loop',
        hint: 'Start again on reaching the end.',
        default: false
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

        /*
        The frame's box, and the gap below the block. On this element rather than :host: see
        block-index.

        -> A max-width rather than a plain width, so a player asked for at 1280 on a phone is the
           width of the phone instead of pushing the page sideways. The aspect ratio then keeps it
           widescreen at whatever width it ends up with, which is what a fixed height would not.
      */
        .player {
          max-width: 100%;
          margin-bottom: 16px;
          border-radius: 5px;
          overflow: hidden;
          border: 1px solid #e0e0e0;
          background-color: #000;
        }

        :host([dark]) .player {
          border-color: rgba(255, 255, 255, 0.15);
        }

        iframe {
          display: block;
          width: 100%;
          height: 100%;
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
       * Address of the video
       * @type {string}
       */
      url: { type: String },

      /**
       * Width of the player in pixels
       * @type {number}
       */
      width: { type: Number },

      /**
       * Height of the player in pixels
       * @type {number}
       */
      height: { type: Number },

      /**
       * Whether to start without being asked
       * @type {boolean}
       */
      autoplay: boolean,

      /**
       * Whether the play bar is shown
       * @type {boolean}
       */
      controls: boolean,

      /**
       * Whether the fullscreen button is offered
       * @type {boolean}
       */
      fs: boolean,

      /**
       * Whether to start again at the end
       * @type {boolean}
       */
      loop: boolean
    }
  }

  constructor() {
    super()
    this.url = ''
    this.width = null
    this.height = null
    this.autoplay = false
    this.controls = true
    this.fs = true
    this.loop = false
    // -> Puts `dark` on this element for the styles above to key off
    this._darkMode = new DarkMode(this)
  }

  /** A prop given a usable number, or null for one left empty. */
  _size(value) {
    const size = Number(value)
    return Number.isFinite(size) && size > 0 ? size : null
  }

  /**
   * The address of the player, with what it was asked for.
   *
   * Only the parameters that were actually changed: an option left out is Dailymotion's own default,
   * which is the one that goes on being maintained.
   */
  _embedUrl(id) {
    const params = new URLSearchParams()
    if (this.autoplay) {
      params.set('autoplay', 'true')
      /*
        -> Muted, because that is the only way it plays. Every browser refuses to start a video with
           sound before the reader has interacted with the page, and refuses silently: the player
           simply sits there, which reads as a block that is broken rather than one being overruled.
      */
      params.set('mute', 'true')
    }
    if (!this.controls) {
      params.set('controls', 'false')
    }
    if (this.loop) {
      params.set('loop', 'true')
    }
    const query = params.toString()
    return `https://www.dailymotion.com/embed/video/${id}${query ? `?${query}` : ''}`
  }

  render() {
    const id = videoId(this.url ?? '')
    if (!id) {
      return renderError(
        this.url?.trim()
          ? `${this.url} is not the address of a Dailymotion video.`
          : 'This player needs the address of a Dailymotion video.'
      )
    }

    const width = this._size(this.width)
    const height = this._size(this.height)
    /*
      A height that was asked for wins outright; without one the frame is widescreen, which is the
      shape all but the oldest videos are. Letterboxing inside the frame is Dailymotion's business
      either way -- the player fits the video to whatever box it is given.
    */
    const style = [
      width ? `width: ${width}px` : 'width: 100%',
      height ? `height: ${height}px` : 'aspect-ratio: 16 / 9'
    ].join('; ')

    return html`
      <div class="player" style=${style}>
        <iframe
          src=${this._embedUrl(id)}
          title="Dailymotion video player"
          loading="lazy"
          referrerpolicy="strict-origin-when-cross-origin"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          ?allowfullscreen=${this.fs}></iframe>
      </div>
    `
  }
}

window.customElements.define('block-dailymotion', BlockDailymotionElement)
