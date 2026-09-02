import { LitElement, css, html } from 'lit'

import { boolean } from './props.js'
import { renderError } from './render.js'
import { errorBox } from './styles.js'

/**
 * The player shell every video-embed block draws -- `block-youtube`, `block-vimeo`,
 * `block-dailymotion`, `block-m365-video`.
 *
 * All four are the same block with a different URL grammar: the same seven props, the same defaults,
 * the same "a width that was asked for, otherwise the column; a height that was asked for, otherwise
 * widescreen" sizing, and the same lazily-loaded `<iframe>` inside the same rounded box -- roughly
 * 260 lines copied four times over before this existed (BLK-F2 / INFRA-F5). What actually differs is
 * the provider's own grammar, which is what the hooks below are for.
 *
 * A subclass writes:
 *
 * - `_parse(source)` -- the provider's URL grammar. Whatever identifies the video (an id, an object,
 *   an address), or `null` for input that names no video. It is the only thing standing between an
 *   author's paste and an `<iframe>`, so it is where a block draws its line about what it will embed.
 * - `_embedUrl(parsed)` -- the address of the player, given what `_parse` returned.
 * - `_providerName()` -- how the provider is named to a reader, for the frame's title and the two
 *   error messages ("YouTube", "Vimeo", ...).
 *
 * and may override:
 *
 * - `_source()` -- which prop the input comes from, for a block whose input is not a `url`
 *   (`block-m365-video` reads a pasted `embed` snippet).
 * - `_missingSourceMessage()` / `_invalidSourceMessage(source)` -- to translate them through
 *   `./i18n.js`, or to say something a provider-specific message says better. Both defaults are
 *   plain English built off `_providerName()`, so an override can wrap `super`'s rather than retype
 *   it.
 * - `_frameTitle()` and `_frameAllow()` -- the frame's accessible name and its permissions policy.
 * - `static styles` -- as `[...VideoEmbedElement.styles, css`…`]`, for the border two of them draw.
 *
 * One behaviour change this shell brought with it: every subclass now has the full seven props,
 * `fs` included, so a hand-written `::block-m365-video{fs="false"}` takes the fullscreen button off
 * that player too -- where before it was an attribute nothing read. Its picker is unaffected, which
 * offers only the props its own `static definition` lists.
 *
 * Deliberately NOT here: `static definition`. It has to stay a plain object literal in each block's
 * own `component.js`, because the build's manifest step, `scripts/check-locale-keys.mjs` and
 * `definitions.test.js` all read it out of the source text rather than by importing the module.
 *
 * `I18n` is not constructed here either: it fetches the page's dictionary on connect, and a block
 * that resolves no keys should not pay for that. A block that translates its messages constructs its
 * own controller, the way `block-youtube` does.
 */

/**
 * The frame's box, the frame, and the gap below the block.
 *
 * `.error`'s own panel comes from `./styles.js`'s `errorBox`; only the gap below it is here, since
 * that is the one declaration whose selector (`.player, .error`) names this family's own element.
 */
export const playerStyles = css`
  :host {
    display: block;
  }

  /*
    The frame's box, and the gap below the block. On this element rather than :host: see block-index.

    -> A max-width rather than a plain width, so a player asked for at 1280 on a phone is the
       width of the phone instead of pushing the page sideways. The aspect ratio then keeps it
       widescreen at whatever width it ends up with, which is what a fixed height would not.
  */
  .player {
    max-width: 100%;
    margin-bottom: 16px;
    border-radius: 5px;
    overflow: hidden;
    background-color: #000;
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

/** What every one of these frames is allowed to do, which no provider here needs narrowing. */
const FRAME_ALLOW =
  'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'

export class VideoEmbedElement extends LitElement {
  static styles = [errorBox, playerStyles]

  static properties = {
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

  constructor() {
    super()
    this.url = ''
    this.width = null
    this.height = null
    this.autoplay = false
    this.controls = true
    this.fs = true
    this.loop = false
  }

  /** A prop given a usable number, or null for one left empty. */
  _size(value) {
    const size = Number(value)
    return Number.isFinite(size) && size > 0 ? size : null
  }

  /**
   * The box the frame is drawn in, as an inline style.
   *
   * A height that was asked for wins outright; without one the frame is widescreen, which is the
   * shape all but the oldest videos are. Letterboxing inside the frame is the provider's business
   * either way -- the player fits the video to whatever box it is given.
   */
  _frameStyle() {
    const width = this._size(this.width)
    const height = this._size(this.height)
    return [
      width ? `width: ${width}px` : 'width: 100%',
      height ? `height: ${height}px` : 'aspect-ratio: 16 / 9'
    ].join('; ')
  }

  /** What the author gave this block to embed. `url`, unless the block reads another prop. */
  _source() {
    return this.url ?? ''
  }

  /** How the provider is named to a reader. Every subclass says. */
  _providerName() {
    return 'video'
  }

  /** The frame's accessible name -- what a screen reader announces the region as. */
  _frameTitle() {
    return `${this._providerName()} video player`
  }

  /** The frame's permissions policy. */
  _frameAllow() {
    return FRAME_ALLOW
  }

  /** Shown in place of the player when the block was given nothing at all. */
  _missingSourceMessage() {
    return `This player needs the address of a ${this._providerName()} video.`
  }

  /** Shown in place of the player when what the block was given names no video it can embed. */
  _invalidSourceMessage(source) {
    return `${source} is not the address of a ${this._providerName()} video.`
  }

  /**
   * Whatever identifies the video in `source`, or null for input that names none.
   *
   * @abstract
   */
  _parse() {
    return null
  }

  /**
   * The address of the player, given what `_parse` returned.
   *
   * @abstract
   */
  _embedUrl() {
    return ''
  }

  render() {
    const source = this._source() ?? ''
    if (!source.trim()) {
      return renderError(this._missingSourceMessage())
    }

    const parsed = this._parse(source)
    if (!parsed) {
      return renderError(this._invalidSourceMessage(source))
    }

    return html`
      <div class="player" style=${this._frameStyle()}>
        <iframe
          src=${this._embedUrl(parsed)}
          title=${this._frameTitle()}
          loading="lazy"
          referrerpolicy="strict-origin-when-cross-origin"
          allow=${this._frameAllow()}
          ?allowfullscreen=${this.fs}></iframe>
      </div>
    `
  }
}
