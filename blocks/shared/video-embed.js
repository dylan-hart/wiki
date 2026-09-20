import { LitElement, css, html } from 'lit'

import { boolean } from './props.js'
import { renderError } from './render.js'
import { errorBox } from './styles.js'

/**
 * The player shell every video-embed block draws -- `block-youtube`, `block-vimeo`,
 * `block-dailymotion`, `block-m365-video`. All four are the same block with a different URL grammar,
 * which is what the `_parse`/`_embedUrl`/`_providerName` hooks are for; a subclass adding styles
 * spreads `VideoEmbedElement.styles` first.
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

const FRAME_ALLOW =
  'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'

export class VideoEmbedElement extends LitElement {
  static styles = [errorBox, playerStyles]

  static properties = {
    url: { type: String },
    width: { type: Number },
    height: { type: Number },
    autoplay: boolean,
    controls: boolean,
    fs: boolean,
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

  _size(value) {
    const size = Number(value)
    return Number.isFinite(size) && size > 0 ? size : null
  }

  /**
   * Without a height asked for, the frame is widescreen -- the shape all but the oldest videos are.
   * Letterboxing inside it is the provider's business either way: the player fits the video to
   * whatever box it is given.
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

  _providerName() {
    return 'video'
  }

  _frameTitle() {
    return `${this._providerName()} video player`
  }

  _frameAllow() {
    return FRAME_ALLOW
  }

  _missingSourceMessage() {
    return `This player needs the address of a ${this._providerName()} video.`
  }

  _invalidSourceMessage(source) {
    return `${source} is not the address of a ${this._providerName()} video.`
  }

  /** @abstract Whatever identifies the video in `source`, or null for input that names none. */
  _parse() {
    return null
  }

  /** @abstract The address of the player, given what `_parse` returned. */
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
