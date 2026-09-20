import { css } from 'lit'

/**
 * A full-viewport modal `<dialog>` for looking at one item of a list full size, with arrow-key
 * navigation and the page held still behind it. `block-gallery/component.js` is the reference
 * integration.
 */

/**
 * A page's main content area commonly has its own scroller rather than the window doing the
 * scrolling (the shell stays put and the column moves), which is the element a lightbox has to hold
 * still while it is open. Same walk as the frontend's `helpers/anchors.js`, for the same reason.
 */
export function scrollerOf(el) {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (/(auto|scroll|overlay)/.test(overflowY) && node.scrollHeight > node.clientHeight + 1) {
      return node
    }
  }
  return document.scrollingElement ?? document.documentElement
}

/**
 * A consumer's `<dialog>` needs the `lightbox` class, and the element inside it that should close
 * the lightbox when clicked directly (as opposed to something drawn over it) needs the `stage`
 * class -- see `LightboxController#onStageClick`. Everything else inside the dialog is the
 * consumer's own markup and its own `css`, added alongside this in `static styles`.
 */
export const lightboxStyles = css`
  /*
    The lightbox is a modal dialog, which is what puts it over the whole site.

    An element in the top layer is drawn above the page whatever the block is nested in -- where a
    fixed-position overlay in the shadow root is still clipped by the first ancestor with a
    transform, a filter or an overflow of its own, and the app has all three between the page and a
    block. Opened this way it also comes with most of what a lightbox has to do anyway: Escape
    closes it, the page behind cannot be tabbed into or clicked, and focus returns to whatever
    opened it. Scrolling is the exception -- see LightboxController's scroll lock.
  */
  .lightbox {
    width: 100vw;
    max-width: 100vw;
    height: 100vh;
    max-height: 100vh;
    margin: 0;
    padding: 0;
    border: 0;
    background-color: transparent;
    overflow: hidden;
    opacity: 0;
    transition:
      opacity 150ms ease,
      overlay 150ms allow-discrete,
      display 150ms allow-discrete;
  }
  .lightbox[open] {
    opacity: 1;
  }
  /* -> Where the fade starts from. Without it the dialog is simply there, which is no worse. */
  @starting-style {
    .lightbox[open] {
      opacity: 0;
    }
  }
  /*
    -> A shade lighter than a flat backdrop would be, since the blur is doing some of the work of
       putting the page away. Not much lighter: dark enough on its own that a browser without
       backdrop-filter loses the softness and nothing else.
  */
  .lightbox::backdrop {
    background-color: rgb(0 0 0 / 0.82);
    backdrop-filter: blur(18px);
  }

  /*
    The clickable ground the enlarged content sits on: anywhere off it closes the lightbox.

    -> border-box, because the padding is what keeps the content clear of chrome drawn over it, and
       a content-box stage is the width of the dialog plus that padding, which pushes what it is
       centring off to one side. The app's own reset does not reach in here.
  */
  .stage {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    padding: 4rem;
    cursor: zoom-out;
  }
  @media (max-width: 640px) {
    .stage {
      padding: 3.5rem 0.5rem;
    }
  }

  .stage img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    cursor: default;
  }
`

export class LightboxController {
  /**
   * @param {import('lit').ReactiveElement} host
   * @param {object} options
   * @param {() => number} options.count how many items there are to step through. Read fresh on
   *   every navigation, so a list whose length changes while the lightbox is open still wraps
   *   against its current size.
   * @param {(index: number) => void} [options.onIndexChange] called after `host.requestUpdate()`
   *   whenever the index changes, closing (with `-1`) included.
   * @param {string} [options.stageClass] the class `onStageClick` treats as the clickable backdrop.
   *   Defaults to `'stage'`, matching `lightboxStyles`.
   * @param {string} [options.dialogSelector] how the controller finds its `<dialog>` inside the
   *   host's `renderRoot`. Defaults to `'.lightbox'`, matching `lightboxStyles`.
   */
  constructor(
    host,
    { count, onIndexChange = null, stageClass = 'stage', dialogSelector = '.lightbox' } = {}
  ) {
    this.host = host
    /** Which item the lightbox is showing; -1 while it is closed. */
    this.index = -1
    this._count = count
    this._onIndexChange = onIndexChange
    this._stageClass = stageClass
    this._dialogSelector = dialogSelector
    this._held = null

    // -> Bound so each may be handed straight to a Lit template as `@event=${this._lightbox.x}`.
    this.open = this.open.bind(this)
    this.close = this.close.bind(this)
    this.previous = this.previous.bind(this)
    this.next = this.next.bind(this)
    this.onClose = this.onClose.bind(this)
    this.onKeydown = this.onKeydown.bind(this)
    this.onStageClick = this.onStageClick.bind(this)

    host.addController(this)
  }

  /**
   * A block taken off the page while its lightbox is open would otherwise leave the article unable
   * to scroll, with nothing left to close it.
   */
  hostDisconnected() {
    this._holdPage(false)
  }

  get dialog() {
    return this.host.renderRoot?.querySelector(this._dialogSelector) ?? null
  }

  wrap(index) {
    const count = this._count()
    return (index + count) % count
  }

  /** Shown only once the item it is showing has been rendered, so it never opens empty. */
  async open(index) {
    this._setIndex(index)
    await this.host.updateComplete
    this.dialog?.showModal()
    this._holdPage(true)
  }

  step(delta) {
    this._setIndex(this.wrap(this.index + delta))
  }

  previous() {
    this.step(-1)
  }

  next() {
    this.step(1)
  }

  close() {
    this.dialog?.close()
  }

  onClose() {
    this._setIndex(-1)
    this._holdPage(false)
  }

  /** Escape is the dialog's own; the arrow keys are what this adds to it. */
  onKeydown(ev) {
    if (ev.key === 'ArrowLeft') {
      ev.preventDefault()
      this.previous()
    } else if (ev.key === 'ArrowRight') {
      ev.preventDefault()
      this.next()
    }
  }

  /**
   * The dialog itself counts as the stage: it is the whole viewport, and a stage narrower than the
   * window -- which is what a portrait window leaves -- puts the edges of the backdrop there.
   */
  onStageClick(ev) {
    if (ev.target === ev.currentTarget || ev.target.classList.contains(this._stageClass)) {
      this.close()
    }
  }

  _setIndex(index) {
    this.index = index
    this.host.requestUpdate()
    this._onIndexChange?.(index)
  }

  /**
   * The one thing a modal dialog does not do for itself: the page behind it cannot be clicked or
   * tabbed into, but a wheel still scrolls it -- so the reader closes the lightbox somewhere other
   * than where they opened it. The offset is put back along with the overflow, because an element
   * that has spent a moment not scrolling does not reliably keep the position it was scrolled to.
   */
  _holdPage(held) {
    if (held) {
      const scroller = scrollerOf(this.host)
      this._held = { scroller, overflow: scroller.style.overflow, top: scroller.scrollTop }
      scroller.style.overflow = 'hidden'
      return
    }
    if (this._held) {
      const { scroller, overflow, top } = this._held
      scroller.style.overflow = overflow
      scroller.scrollTop = top
      this._held = null
    }
  }
}
