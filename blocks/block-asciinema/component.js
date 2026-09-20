import { LitElement, html, css, unsafeCSS } from 'lit'
import { create } from 'asciinema-player'
// -> A <link> in the page cannot reach into this shadow root, so the stylesheet is imported as a
//    string instead — the `cssAsString` plugin in rolldown.config.mjs is what makes that work.
import playerCss from 'asciinema-player/dist/bundle/asciinema-player.css'
import { boolean } from '../shared/props.js'
import { renderError } from '../shared/render.js'
import { errorBox } from '../shared/styles.js'

export class BlockAsciinemaElement extends LitElement {
  /**
   * Read out of the source text at build time rather than by importing the module, so every value
   * must stay a plain literal.
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

        /* -> Not on :host: the app's margin reset in the page beats a :host rule whatever the
              specificity. */
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
       * Explicit `attribute`: Lit's default lowercases without inserting a dash (`autoplay`), but
       * the picker writes `static definition.props[].name` verbatim.
       */
      autoPlay: { ...boolean, attribute: 'auto-play' },

      loop: boolean,

      speed: { type: Number },

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
   * Only the settings actually asked for — an option left out falls to the player's own default,
   * which is the maintained one. Speed is bounded because zero or a negative value stops the
   * recording dead and a nonsense number takes the player with it.
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
   * Handed a URL, the player fetches it itself and a failure leaves an empty terminal with the
   * reason only in the console — invisible to an author who mistyped a path. The response is passed
   * on whole rather than read here, so the player can still stream it.
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
      A function rather than the recording itself, so nothing is fetched until it is played: a page
      carrying a recording should not pull the whole thing down unasked.
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
