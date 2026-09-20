import { css } from 'lit'

import { I18n } from '../shared/i18n.js'
import { DarkMode } from '../shared/theme.js'
import { VideoEmbedElement } from '../shared/video-embed.js'

const HOSTS = /^(?:www\.)?dailymotion\.com$/
const SHORT_HOST = 'dai.ly'

/** Length deliberately unchecked — that is Dailymotion's to change. */
const ID = /^[A-Za-z0-9]+$/

/**
 * A share link carries the id after `/video/`, often followed by a `_`-joined title slug the id
 * itself never contains (`dailymotion.com/video/<id>_some-title`); the short link and the embed
 * address carry the bare id, and a bare id pasted on its own is accepted as one.
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

export class BlockDailymotionElement extends VideoEmbedElement {
  /**
   * Read out of the source text at build time rather than by importing the module, so every value
   * must stay a plain literal.
   */
  static definition = {
    block: 'dailymotion',
    name: 'Dailymotion Player',
    description: 'Embeds a Dailymotion video.',
    icon: 'tabler:movie',
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

  /*
    A Dailymotion player's own frame sits flush to its edges, so without this border it has no
    boundary against the page.
  */
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
    return 'Dailymotion'
  }

  _parse(source) {
    return videoId(source)
  }

  _missingSourceMessage() {
    return this._i18n.t('blocks.dailymotion.errors.missingUrl', super._missingSourceMessage())
  }

  _invalidSourceMessage(source) {
    return this._i18n.t(
      'blocks.dailymotion.errors.invalidUrl',
      super._invalidSourceMessage(source),
      { url: source }
    )
  }

  /**
   * Only the parameters actually changed — one left out falls to Dailymotion's own default, which is
   * the maintained one.
   */
  _embedUrl(id) {
    const params = new URLSearchParams()
    if (this.autoplay) {
      params.set('autoplay', 'true')
      /*
        -> Muted, because that is the only way it plays: browsers refuse an unmuted autostart before
           the reader has interacted with the page, and refuse it silently — the player just sits
           there, reading as a broken block rather than an overruled one.
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
}

window.customElements.define('block-dailymotion', BlockDailymotionElement)
