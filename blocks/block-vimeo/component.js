import { css } from 'lit'

import { I18n } from '../shared/i18n.js'
import { DarkMode } from '../shared/theme.js'
import { VideoEmbedElement } from '../shared/video-embed.js'

const HOSTS = /^(?:www\.)?vimeo\.com$/
const PLAYER_HOST = 'player.vimeo.com'

const ID = /^\d+$/

/**
 * A share link carries the id as its first path segment (`vimeo.com/<id>`), optionally followed by
 * the privacy hash unlisted videos are given (`vimeo.com/<id>/<hash>`); a player link carries the
 * same two in `/video/<id>` and `?h=<hash>`. A bare id is taken as one too.
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

export class BlockVimeoElement extends VideoEmbedElement {
  /**
   * Read out of the source text at build time rather than by importing the module, so every value
   * has to stay a plain literal.
   */
  static definition = {
    block: 'vimeo',
    name: 'Vimeo Player',
    description: 'Embeds a Vimeo video.',
    icon: 'tabler:brand-vimeo',
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

  /* A Vimeo player sits flush to its edges, so without a border it has no boundary against the page. */
  static styles = [
    ...VideoEmbedElement.styles,
    css`
      .player {
        border: 1px solid var(--block-border);
      }
    `
  ]

  constructor() {
    super()
    this._darkMode = new DarkMode(this)
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
   * Only the parameters actually changed are sent: an option left out is Vimeo's own default, which
   * is the one that goes on being maintained.
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
        -> Muted, because that is the only way it plays: browsers refuse to start a video with sound
           before the reader has interacted with the page, and refuse silently -- the player just
           sits there, reading as a broken block rather than an overruled one.
      */
      params.set('muted', '1')
    }
    if (!this.controls) {
      params.set('controls', '0')
    }
    if (!this.fs) {
      // -> Dropping `allowfullscreen` from the iframe is what denies fullscreen, but leaves Vimeo's
      //    own button sitting there doing nothing; this hides it too
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
