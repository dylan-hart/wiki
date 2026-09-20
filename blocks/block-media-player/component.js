import { LitElement, html, css } from 'lit'

import { renderError } from '../shared/render.js'
import { errorBox } from '../shared/styles.js'
import { DarkMode } from '../shared/theme.js'

/**
 * Ogg is the one ambiguous family — the container carries either — so a bare `.ogg` is taken as
 * audio, the far more common file to be handed, and `.ogv` is there for an author who means video.
 */
const VIDEO_TYPES = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg'
}

const AUDIO_TYPES = {
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4'
}

function extensionOf(src) {
  const clean = src.split(/[?#]/)[0]
  const match = /\.([a-z0-9]+)$/i.exec(clean)
  return match ? match[1].toLowerCase() : ''
}

/** @returns {{ kind: 'video' | 'audio', mime: string } | null} */
function mediaKind(src) {
  const ext = extensionOf(src)
  if (ext in VIDEO_TYPES) {
    return { kind: 'video', mime: VIDEO_TYPES[ext] }
  }
  if (ext in AUDIO_TYPES) {
    return { kind: 'audio', mime: AUDIO_TYPES[ext] }
  }
  return null
}

export class BlockMediaPlayerElement extends LitElement {
  /**
   * Read out of this source text at build time into `compiled/blocks.manifest.json`, so every value
   * has to stay a plain literal.
   */
  static definition = {
    block: 'media-player',
    name: 'Media Player',
    description: 'Plays an audio or video file inline.',
    icon: 'tabler:playlist',
    props: [
      {
        name: 'src',
        type: 'string',
        label: 'Source URL',
        hint: 'Path or URL of the audio or video file to play.',
        required: true
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
        .container {
          margin-bottom: 16px;
          overflow: hidden;
          border-radius: var(--block-radius);
          position: relative;
          border: 1px solid var(--block-border);
          background-color: #000;
        }

        .media-display {
          display: block;
          width: 100%;
        }

        audio.media-display {
          height: 54px;
        }

        .error {
          margin-bottom: 16px;
        }
      `
    ]
  }

  static get properties() {
    return {
      src: { type: String },
      _error: { state: true }
    }
  }

  constructor() {
    super()
    this.src = ''
    this._error = ''
    this._darkMode = new DarkMode(this)
  }

  _onError() {
    this._error = `This file could not be played from ${this.src}`
  }

  render() {
    const src = this.src?.trim()
    if (!src) {
      return renderError('This player needs the address of an audio or video file.')
    }
    if (this._error) {
      return renderError(this._error)
    }

    const media = mediaKind(src)
    if (!media) {
      return renderError(`${src} does not have a recognised audio or video file extension.`)
    }

    return html`
      <div class="container">
        ${
          media.kind === 'video'
            ? html`
                <video class="media-display" controls>
                  <source src="${src}" type="${media.mime}" @error="${() => this._onError()}" />
                </video>
              `
            : html`
                <audio class="media-display" controls>
                  <source src="${src}" type="${media.mime}" @error="${() => this._onError()}" />
                </audio>
              `
        }
      </div>
    `
  }
}

window.customElements.define('block-media-player', BlockMediaPlayerElement)
