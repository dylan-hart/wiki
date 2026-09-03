import { css } from 'lit'

import { I18n } from '../shared/i18n.js'
import { DarkMode } from '../shared/theme.js'
import { VideoEmbedElement } from '../shared/video-embed.js'

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
export class BlockVimeoElement extends VideoEmbedElement {
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

  /*
    The shared player shell, plus the border this one draws around it — a Vimeo player's own frame
    sits flush to its edges, so without one it has no boundary against the page.
  */
  static styles = [
    ...VideoEmbedElement.styles,
    css`
      .player {
        border: 1px solid #e0e0e0;
      }

      :host([dark]) .player {
        border-color: rgba(255, 255, 255, 0.15);
      }
    `
  ]

  constructor() {
    super()
    // -> Puts `dark` on this element for the styles above to key off
    this._darkMode = new DarkMode(this)
    // -> Resolves the two messages below against the page's locale; see `../shared/i18n.js`
    this._i18n = new I18n(this)
  }

  _providerName() {
    return 'Vimeo'
  }

  _parse(source) {
    return parseUrl(source)
  }

  _missingSourceMessage() {
    return this._i18n.t('blocks.vimeo.errors.missingUrl', super._missingSourceMessage())
  }

  _invalidSourceMessage(source) {
    return this._i18n.t('blocks.vimeo.errors.invalidUrl', super._invalidSourceMessage(source), {
      url: source
    })
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
}

window.customElements.define('block-vimeo', BlockVimeoElement)
