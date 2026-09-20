import { I18n } from '../shared/i18n.js'
import { VideoEmbedElement } from '../shared/video-embed.js'

const HOSTS = /^(?:www\.|m\.)?youtube(?:-nocookie)?\.com$/

const ID_PATHS = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/

/** Length is deliberately not checked: that is YouTube's to change, not ours. */
const ID = /^[A-Za-z0-9_-]+$/

/** A timestamp as YouTube writes it in a share link: `1m30s`, `1h2m3s`. */
const TIMESTAMP = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/

/**
 * A bare id is taken as a video too — it is what an author who copied the id rather than the link
 * will paste, and there is nothing else an eleven-character word could be meant as here.
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
    host === 'youtu.be'
      ? url.pathname.slice(1).split('/')[0]
      : !HOSTS.test(host)
        ? null
        : url.pathname === '/watch'
          ? url.searchParams.get('v')
          : (ID_PATHS.exec(url.pathname)?.[1] ?? null)
  return id && ID.test(id) ? id : null
}

/**
 * `t` is what YouTube's "copy link at current time" button adds, either as a plain count of seconds
 * or as `1m30s`; `start` is the same thing spelled the way the embed parameter is.
 */
function linkStart(source) {
  const url = URL.parse(source.trim()) ?? URL.parse(`https://${source.trim()}`)
  const value = url?.searchParams.get('t') ?? url?.searchParams.get('start') ?? ''
  if (/^\d+$/.test(value)) {
    return Number(value)
  }
  const parts = TIMESTAMP.exec(value)
  if (!parts || !parts.slice(1).some(Boolean)) {
    return 0
  }
  return Number(parts[1] ?? 0) * 3600 + Number(parts[2] ?? 0) * 60 + Number(parts[3] ?? 0)
}

export class BlockYoutubeElement extends VideoEmbedElement {
  /**
   * Read out of the source text at build time rather than by importing the module, so every value
   * has to stay a plain literal.
   */
  static definition = {
    block: 'youtube',
    name: 'YouTube Player',
    description: 'Embeds a YouTube video.',
    icon: 'tabler:brand-youtube',
    props: [
      {
        name: 'url',
        type: 'string',
        label: 'Video URL',
        hint: 'Address of the video, as YouTube gives it — a watch, youtu.be or shorts link.',
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
      },
      {
        name: 'start',
        type: 'number',
        label: 'Start At',
        hint: 'Seconds into the video to start at. 0 uses the time in the URL, if it carries one.',
        default: 0
      }
    ]
  }

  static properties = {
    start: { type: Number }
  }

  constructor() {
    super()
    this.start = 0
    this._i18n = new I18n(this)
  }

  _providerName() {
    return 'YouTube'
  }

  _parse(source) {
    return videoId(source)
  }

  _missingSourceMessage() {
    return this._i18n.t('blocks.youtube.errors.missingUrl', super._missingSourceMessage())
  }

  _invalidSourceMessage(source) {
    return this._i18n.t('blocks.youtube.errors.invalidUrl', super._invalidSourceMessage(source), {
      url: source
    })
  }

  /**
   * Only the parameters actually changed are sent: an option left out is YouTube's own default,
   * which is the one that goes on being maintained.
   */
  _embedUrl(id) {
    const params = new URLSearchParams()
    if (this.autoplay) {
      params.set('autoplay', '1')
      /*
        -> Muted, because that is the only way it plays: browsers refuse to start a video with sound
           before the reader has interacted with the page, and refuse silently -- the player just
           sits there, reading as a broken block rather than an overruled one.
      */
      params.set('mute', '1')
    }
    if (!this.controls) {
      params.set('controls', '0')
    }
    if (!this.fs) {
      params.set('fs', '0')
    }
    if (this.loop) {
      params.set('loop', '1')
      // -> A single video loops only as a playlist of itself; `loop` alone does nothing to one
      params.set('playlist', id)
    }
    const start = this._size(this.start) ?? linkStart(this.url)
    if (start > 0) {
      params.set('start', String(start))
    }
    const query = params.toString()
    return `https://www.youtube.com/embed/${id}${query ? `?${query}` : ''}`
  }
}

window.customElements.define('block-youtube', BlockYoutubeElement)
