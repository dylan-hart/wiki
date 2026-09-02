import { LitElement, html, css } from 'lit'

import { boolean } from '../shared/props.js'
import { renderError } from '../shared/render.js'
import { errorBox } from '../shared/styles.js'
import { DarkMode } from '../shared/theme.js'

/** Every Vimeo host a link can arrive on: the share link and the player's own address. */
const HOSTS = /^(?:www\.)?vimeo\.com$/
const PLAYER_HOST = 'player.vimeo.com'

/** What a Vimeo video id is made of — purely numeric, unlike YouTube's mixed-case ids. */
const ID = /^\d+$/

/**
 * The video a link points at, or null for a link that points at no video.
 *
 * A share link carries the id as its first path segment (`vimeo.com/<id>`), optionally followed by
 * the privacy hash unlisted videos are given (`vimeo.com/<id>/<hash>`); a player link carries the same
 * two in `/video/<id>` and `?h=<hash>`. A bare id is taken as one too, the same as `block-youtube`
 * does for a pasted id rather than a link.
 */
function parseUrl(source) {
  const value = source.trim()
  if (!value) {
    return null
  }
  if (ID.test(value)) {
    return { id: value, hash: null }
  }
  // -> A link written without a scheme is still a link; `new URL` disagrees, so it is given one
  const url = URL.parse(value) ?? URL.parse(`https://${value}`)
  if (!url) {
    return null
  }
  const host = url.hostname.toLowerCase()
  if (host === PLAYER_HOST) {
    const match = /^\/video\/(\d+)/.exec(url.pathname)
    return match ? { id: match[1], hash: url.searchParams.get('h') } : null
  }
  if (!HOSTS.test(host)) {
    return null
  }
  const [id, hash] = url.pathname.split('/').filter(Boolean)
  return id && ID.test(id) ? { id, hash: hash ?? null } : null
}

/**
 * Block Vimeo
 *
 * A Vimeo player, from the address of a video. Nothing is fetched until the frame is scrolled near,
 * and the frame is the only thing here: the player, its controls and everything it does are Vimeo's,
 * driven by the parameters below.
 */
export class BlockVimeoElement extends LitElement {
  /**
   * Metadata for the admin area and the editor's block picker. Collected at build time into
   * `compiled/blocks.manifest.json`, which the server reads to register the block. Values must be
   * plain literals. See `props` in `block-index` for what the picker does with that list.
   */
  static definition = {
    block: 'vimeo',
    name: 'Vimeo Player',
    description: 'Embeds a Vimeo video.',
    icon: 'widescreen',
    props: [
      {
        name: 'url',
        type: 'string',
        label: 'Video URL',
        hint: 'Address of the video, as Vimeo gives it — a vimeo.com or player.vimeo.com link.',
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
   * Only the parameters that were actually changed: an option left out is Vimeo's own default,
   * which is the one that goes on being maintained.
   */
  _embedUrl({ id, hash }) {
    const params = new URLSearchParams()
    if (hash) {
      // -> Required to play an unlisted video at all; Vimeo rejects the id alone for one
      params.set('h', hash)
    }
    if (this.autoplay) {
      params.set('autoplay', '1')
      /*
        -> Muted, because that is the only way it plays. Every browser refuses to start a video with
           sound before the reader has interacted with the page, and refuses silently: the player
           simply sits there, which reads as a block that is broken rather than one being overruled.
      */
      params.set('muted', '1')
    }
    if (!this.controls) {
      params.set('controls', '0')
    }
    if (!this.fs) {
      // -> Hides Vimeo's own fullscreen button; `allowfullscreen` on the iframe is what stops the
      //    browser actually granting fullscreen, but leaves the button sitting there doing nothing
      //    without this, same trap the `mute` param above avoids for autoplay.
      params.set('fullscreen', '0')
    }
    if (this.loop) {
      params.set('loop', '1')
    }
    const query = params.toString()
    return `https://player.vimeo.com/video/${id}${query ? `?${query}` : ''}`
  }

  render() {
    const video = parseUrl(this.url ?? '')
    if (!video) {
      return renderError(
        this.url?.trim()
          ? `${this.url} is not the address of a Vimeo video.`
          : 'This player needs the address of a Vimeo video.'
      )
    }

    const width = this._size(this.width)
    const height = this._size(this.height)
    /*
      A height that was asked for wins outright; without one the frame is widescreen, which is the
      shape all but the oldest videos are. Letterboxing inside the frame is Vimeo's business either
      way -- the player fits the video to whatever box it is given.
    */
    const style = [
      width ? `width: ${width}px` : 'width: 100%',
      height ? `height: ${height}px` : 'aspect-ratio: 16 / 9'
    ].join('; ')

    return html`
      <div class="player" style=${style}>
        <iframe
          src=${this._embedUrl(video)}
          title="Vimeo video player"
          loading="lazy"
          referrerpolicy="strict-origin-when-cross-origin"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          ?allowfullscreen=${this.fs}></iframe>
      </div>
    `
  }
}

window.customElements.define('block-vimeo', BlockVimeoElement)
