import { LitElement, html, css, unsafeCSS } from 'lit'
import { create } from 'asciinema-player'
// -> The player's stylesheet, as a string. It is what draws the terminal, and a <link> in the page
//    cannot reach into this shadow root — see the `cssAsString` plugin in rolldown.config.mjs.
import playerCss from 'asciinema-player/dist/bundle/asciinema-player.css'
import { boolean } from '../shared/props.js'
import { renderError } from '../shared/render.js'
import { errorBox } from '../shared/styles.js'

export class BlockAsciinemaElement extends LitElement {
  /**
   * Collected at build time into `compiled/blocks.manifest.json` by reading this object literal out
   * of the source text, not by importing the module -- so every value here must be a plain literal.
   */
  static definition = {
    block: 'asciinema',
    name: 'Terminal Recording',
    description: 'Plays an asciinema recording — a .cast file — in a terminal player.',
    icon: 'tabler:terminal-2',
    props: [
      {
        name: 'src',
        type: 'string',
        label: 'Recording URL',
        hint: 'Path or URL of the .cast file to play.',
        required: true
      },
      {
        name: 'theme',
        type: 'select',
        label: 'Theme',
        options: [
          'asciinema',
          'dracula',
          'gruvbox-dark',
          'monokai',
          'nord',
          'seti',
          'solarized-dark',
          'solarized-light',
          'tango'
        ],
        hint: 'Terminal colours. All but solarized-light are dark.',
        default: 'asciinema'
      },
      {
        name: 'auto-play',
        type: 'boolean',
        label: 'Play On Load',
        hint: 'Start as soon as the page is opened, rather than waiting to be asked.',
        // -> Stated, so that a toggle switched on and then off again writes nothing into the page
        default: false
      },
      {
        name: 'loop',
        type: 'boolean',
        label: 'Loop',
        hint: 'Start again on reaching the end.',
        default: false
      },
      {
        name: 'speed',
        type: 'number',
        label: 'Speed',
        hint: 'Playback rate. 2 plays twice as fast as it was recorded.',
        default: 1
      },
      {
        name: 'idle-time-limit',
        type: 'number',
        label: 'Idle Time Limit',
        hint: 'Cap the pauses in the recording at this many seconds. Empty keeps them as recorded.'
      }
    ]
  }

  static get styles() {
    return [
      unsafeCSS(playerCss),
      errorBox,
      css`
        :host {
          display: block;
        }

        /* -> The gap below the block. On this element rather than :host: see block-index. */
        .player,
        .error {
          margin-bottom: 16px;
        }

        .player {
          border-radius: var(--block-radius);
          /* -> The terminal paints its own background into the corners otherwise */
          overflow: hidden;
        }
      `
    ]
  }

  static get properties() {
    return {
      src: { type: String },

      theme: { type: String },

      /**
       * Explicit `attribute`, because Lit's default (a bare lowercasing of the property name, no
       * dash inserted) would listen for `autoplay` while the block picker — which writes the
       * literal `static definition.props[].name`, `auto-play` — writes `auto-play` into the page.
       */
      autoPlay: { ...boolean, attribute: 'auto-play' },

      loop: boolean,

      speed: { type: Number },

      /**
       * Explicit `attribute`, for the same reason as `autoPlay` above: the picker writes the
       * dashed `idle-time-limit`, not Lit's default lowercased `idletimelimit`.
       */
      idleTimeLimit: { type: Number, attribute: 'idle-time-limit' },

      _error: { state: true }
    }
  }

  constructor() {
    super()
    this.src = ''
    this.theme = 'asciinema'
    this.autoPlay = false
    this.loop = false
    this.speed = 1
    this.idleTimeLimit = null
    this._error = ''
    this._player = null
  }

  /**
   * Only the settings that were actually asked for: an option left out is the player's own default,
   * which is the one that gets maintained. A speed of zero or a negative one would stop the recording
   * dead, and a nonsense number would take the player with it, so that one is bounded.
   */
  _options() {
    const speed = Number(this.speed)
    const idle = Number(this.idleTimeLimit)
    return {
      theme: this.theme || 'asciinema',
      autoPlay: this.autoPlay,
      loop: this.loop,
      speed: Number.isFinite(speed) && speed > 0 ? Math.min(speed, 10) : 1,
      ...(Number.isFinite(idle) && idle > 0 ? { idleTimeLimit: idle } : {}),
      // -> A recording is as wide as the terminal it was made in, which is rarely this column's width
      fit: 'width'
    }
  }

  /**
   * Handed a URL, the player fetches it on its own and a failure leaves an empty terminal with the
   * reason only in the console — invisible to an author who mistyped a path. Fetching here instead
   * catches that failure and surfaces it in the block. The response is handed over whole, which the
   * player accepts as-is and can stream, rather than read here for no benefit.
   */
  async _fetch(src) {
    try {
      const response = await fetch(src)
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`.trim())
      }
      return response
    } catch (err) {
      this._error = `This recording could not be loaded from ${src} — ${err.message}`
      throw err
    }
  }

  firstUpdated() {
    const src = this.src?.trim()
    if (!src) {
      this._error = 'This player needs the address of a .cast recording.'
      return
    }
    /*
      A function rather than the recording itself, so that nothing is fetched until it is played —
      which is the player's own behaviour, and the right one: a page carrying a recording should not
      pull the whole thing down before anybody has asked to watch it.
    */
    this._player = create(
      { data: () => this._fetch(src) },
      this.renderRoot.querySelector('.player'),
      this._options()
    )
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    // -> The player keeps listeners on window and a resize observer, which outlive the element
    this._player?.dispose()
    this._player = null
  }

  render() {
    if (this._error) {
      return renderError(this._error)
    }
    return html`<div class="player"></div>`
  }
}

window.customElements.define('block-asciinema', BlockAsciinemaElement)
