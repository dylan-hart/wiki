import { LitElement, html, css } from 'lit'

import { renderError } from '../shared/render.js'
import { errorBox } from '../shared/styles.js'
import { DarkMode } from '../shared/theme.js'

/**
 * MIME type per file extension, keyed lowercase and without the dot.
 *
 * `ogg`/`oga`/`ogv` are the one ambiguous family — Ogg is a container that carries either video or
 * audio — so a bare `.ogg` is taken as audio: that is the far more common file to actually be handed
 * one of, and `.ogv` exists for an author who specifically means video.
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

/**
 * The extension off the end of a path or URL, lowercase and without its dot — or '' for one with
 * none. Query strings and fragments are stripped first, so a signed URL's `?token=...` does not end
 * up read as the extension.
 */
function extensionOf(src) {
  const clean = src.split(/[?#]/)[0]
  const match = /\.([a-z0-9]+)$/i.exec(clean)
  return match ? match[1].toLowerCase() : ''
}

/**
 * What to play `src` as, and with which MIME type — or null for an extension neither list
 * recognises.
 *
 * @returns {{ kind: 'video' | 'audio', mime: string } | null}
 */
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

/**
 * Block Media Player
 */
export class BlockMediaPlayerElement extends LitElement {
  /**
   * Metadata for the admin area and the editor's block picker. Collected at build time into
   * `compiled/blocks.manifest.json`, which the server reads to register the block. Values must be
   * plain literals. See `props` in `block-index` for what the picker does with that list.
   */
  static definition = {
    block: 'media-player',
    name: 'Media Player',
    description: 'Plays an audio or video file inline.',
    icon: 'video-playlist',
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
          border-radius: 5px;
          position: relative;
          border: 1px solid #e0e0e0;
          background-color: #000;
        }

        :host([dark]) .container {
          border-color: rgba(255, 255, 255, 0.15);
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
      /**
       * Source URL
       * @type {string}
       */
      src: { type: String },

      // Internal Properties
      _error: { state: true }
    }
  }

  constructor() {
    super()
    this.src = ''
    this._error = ''
    // -> Puts `dark` on this element for the styles above to key off
    this._darkMode = new DarkMode(this)
  }

  /** The media element failed to load or play `src` — a 404, or a format the browser can't decode. */
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
