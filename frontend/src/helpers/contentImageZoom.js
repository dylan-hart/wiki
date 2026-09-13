/**
 * Click-to-zoom for ordinary content images (OpenProject #3066).
 *
 * Every `<img>` `enhanceRenderedContent` (`renderedContent.js`) walks over becomes clickable,
 * opening one shared, lazily-created full-viewport `<dialog>` at the image's own `src` -- there is
 * no thumbnail/responsive variant to prefer instead, so "full resolution" is simply whatever the
 * page already rendered. Once open, the image can be zoomed past 100% with the mouse wheel,
 * two-finger pinch, or the dialog's own +/- buttons, and panned by dragging while zoomed.
 *
 * This deliberately does NOT import `blocks/shared/lightbox.js`'s `LightboxController` (OpenProject
 * #3065's extraction), even though the two are conceptually the same primitive. That controller is
 * a Lit `ReactiveController` -- it calls `host.addController`, reads `host.renderRoot` and
 * `host.requestUpdate`/`host.updateComplete` -- which requires a Lit `ReactiveElement` host to
 * attach to. `frontend/` has no `lit` dependency (only `blocks/package.json` does), and content here
 * arrives as plain DOM written by `v-html`, not a Lit component: there is no host, and adding one
 * (or adding `lit` to `frontend/` at all) would cross the workspace boundary CLAUDE.md documents --
 * four independently-installed workspaces, each with its own `package.json`/`node_modules`. #3048's
 * own scope note anticipated exactly this ("into `blocks/shared/` **or an equivalent frontend
 * helper**"), so this module is that equivalent: the same shell/behavior contract (full-viewport
 * `<dialog>`, backdrop, Escape closes it natively, scroll lock while open), implemented natively in
 * plain DOM/JS rather than through Lit.
 *
 * Wired into `enhanceRenderedContent`, so it runs on both the live page and the editor preview,
 * exactly like the code-copy button and heading anchors it sits beside.
 */

const ROOT_CLASS = 'content-image-lightbox'
const ZOOMED_CLASS = 'is-zoomed'
const PANNING_CLASS = 'is-panning'

const ZOOM_MIN = 1
const ZOOM_MAX = 6
const ZOOM_STEP = 0.5
const WHEEL_SENSITIVITY = 0.0015

let dialogEl = null
let stageEl = null
let imgEl = null
let scale = ZOOM_MIN
let translateX = 0
let translateY = 0
let dragState = null
let pinchState = null
let heldScroll = null

/**
 * The scrollable ancestor that actually moves when the reader scrolls -- held still while the
 * lightbox is open, same as `blocks/shared/lightbox.js#scrollerOf` and `helpers/anchors.js`'s own
 * private copy. Kept as its own small copy here too rather than an import: the three sit in two
 * independently-installed workspaces (`frontend/`, `blocks/`) plus this file's own sibling, and none
 * of the three shares a module boundary with either of the others.
 */
function scrollerOf(el) {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (/(auto|scroll|overlay)/.test(overflowY) && node.scrollHeight > node.clientHeight + 1) {
      return node
    }
  }
  return document.scrollingElement ?? document.documentElement
}

/** Stop the page moving under the lightbox, and let it go again afterwards -- see
 *  `blocks/shared/lightbox.js#_holdPage` for the fuller reasoning; this is the same trick. */
function holdPage(held) {
  if (held) {
    const scroller = scrollerOf(dialogEl)
    heldScroll = { scroller, overflow: scroller.style.overflow, top: scroller.scrollTop }
    scroller.style.overflow = 'hidden'
    return
  }
  if (heldScroll) {
    const { scroller, overflow, top } = heldScroll
    scroller.style.overflow = overflow
    scroller.scrollTop = top
    heldScroll = null
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function applyTransform() {
  imgEl.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`
  dialogEl.classList.toggle(ZOOMED_CLASS, scale > ZOOM_MIN)
}

function setScale(next) {
  const clamped = clamp(next, ZOOM_MIN, ZOOM_MAX)
  if (clamped === scale) {
    return
  }
  scale = clamped
  if (scale === ZOOM_MIN) {
    translateX = 0
    translateY = 0
  }
  applyTransform()
}

function onWheel(ev) {
  ev.preventDefault()
  setScale(scale * (1 - ev.deltaY * WHEEL_SENSITIVITY))
}

function onZoomIn() {
  setScale(scale + ZOOM_STEP)
}

function onZoomOut() {
  setScale(scale - ZOOM_STEP)
}

/** Panning, once zoomed. Pointer Events cover mouse, pen and single-finger touch alike, so this is
 *  the one drag implementation for all three. */
function onPointerDown(ev) {
  if (scale <= ZOOM_MIN || (ev.pointerType === 'mouse' && ev.button !== 0)) {
    return
  }
  ev.preventDefault()
  dragState = {
    pointerId: ev.pointerId,
    startX: ev.clientX,
    startY: ev.clientY,
    originX: translateX,
    originY: translateY
  }
  imgEl.setPointerCapture?.(ev.pointerId)
  dialogEl.classList.add(PANNING_CLASS)
}

function onPointerMove(ev) {
  if (!dragState || ev.pointerId !== dragState.pointerId) {
    return
  }
  translateX = dragState.originX + (ev.clientX - dragState.startX)
  translateY = dragState.originY + (ev.clientY - dragState.startY)
  applyTransform()
}

function endDrag(ev) {
  if (dragState && ev.pointerId === dragState.pointerId) {
    dragState = null
    dialogEl.classList.remove(PANNING_CLASS)
  }
}

/** The on-screen distance between two touches, for measuring a pinch. */
function touchDistance(touches) {
  const [a, b] = touches
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

/**
 * Two-finger pinch-to-zoom, handled through raw `Touch` events rather than folded into the
 * Pointer-Events pan above: each touch of a pinch also fires its own `pointerdown`/`pointermove`,
 * and gating this handler on `ev.touches.length === 2` is what keeps the two from fighting over the
 * same gesture, rather than needing either API to suppress the other.
 */
function onTouchStart(ev) {
  if (ev.touches.length === 2) {
    pinchState = { distance: touchDistance(ev.touches), scale }
  }
}

function onTouchMove(ev) {
  if (!pinchState || ev.touches.length !== 2) {
    return
  }
  ev.preventDefault()
  setScale(pinchState.scale * (touchDistance(ev.touches) / pinchState.distance))
}

function onTouchEnd(ev) {
  if (ev.touches.length < 2) {
    pinchState = null
  }
}

/** A click on the ground the enlarged image sits on, rather than on the image itself or a button
 *  drawn over it -- same convention as `blocks/shared/lightbox.js#onStageClick`. */
function onStageClick(ev) {
  if (ev.target === dialogEl || ev.target === stageEl) {
    dialogEl.close()
  }
}

function onDialogClose() {
  holdPage(false)
  scale = ZOOM_MIN
  translateX = 0
  translateY = 0
  imgEl.removeAttribute('src')
  imgEl.style.transform = ''
  dialogEl.classList.remove(ZOOMED_CLASS, PANNING_CLASS)
}

function makeControlButton(glyph, label) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `${ROOT_CLASS}-button`
  button.textContent = glyph
  button.setAttribute('aria-label', label)
  return button
}

/** Builds the one shared dialog on first use. `t` is read once, here, for the controls' labels --
 *  the locale does not change mid-session without a full reload, so there is nothing to keep in
 *  sync afterwards. */
function ensureDialog(t) {
  if (dialogEl) {
    return dialogEl
  }

  dialogEl = document.createElement('dialog')
  dialogEl.className = ROOT_CLASS

  stageEl = document.createElement('div')
  stageEl.className = 'stage'

  imgEl = document.createElement('img')
  imgEl.draggable = false
  imgEl.alt = ''

  const controls = document.createElement('div')
  controls.className = `${ROOT_CLASS}-controls`

  const zoomOutBtn = makeControlButton('−', t('common.renderedContent.zoomOut'))
  const zoomInBtn = makeControlButton('+', t('common.renderedContent.zoomIn'))
  const closeBtn = makeControlButton('×', t('common.actions.close'))
  zoomOutBtn.addEventListener('click', onZoomOut)
  zoomInBtn.addEventListener('click', onZoomIn)
  closeBtn.addEventListener('click', () => dialogEl.close())
  controls.append(zoomOutBtn, zoomInBtn, closeBtn)

  stageEl.appendChild(imgEl)
  dialogEl.append(stageEl, controls)
  document.body.appendChild(dialogEl)

  stageEl.addEventListener('wheel', onWheel, { passive: false })
  stageEl.addEventListener('touchstart', onTouchStart, { passive: true })
  stageEl.addEventListener('touchmove', onTouchMove, { passive: false })
  stageEl.addEventListener('touchend', onTouchEnd)
  stageEl.addEventListener('touchcancel', onTouchEnd)
  imgEl.addEventListener('pointerdown', onPointerDown)
  imgEl.addEventListener('pointermove', onPointerMove)
  imgEl.addEventListener('pointerup', endDrag)
  imgEl.addEventListener('pointercancel', endDrag)
  dialogEl.addEventListener('click', onStageClick)
  dialogEl.addEventListener('close', onDialogClose)

  return dialogEl
}

function openLightbox(src, alt, t) {
  ensureDialog(t)
  imgEl.src = src
  imgEl.alt = alt ?? ''
  dialogEl.showModal()
  holdPage(true)
}

/**
 * Wire every content image under `root` to open the lightbox on click.
 *
 * Idempotent, the same convention `addCodeCopyButtons` uses in `renderedContent.js`: a
 * `data-content-zoom` marker keeps a later pass over unchanged content from adding a second
 * listener. An image that is itself inside a link (markdown's `[![alt](img)](href)` pattern, which
 * makes the image double as a hyperlink) is marked but deliberately left unwired, so clicking it
 * keeps following the link rather than silently losing it to the lightbox.
 *
 * @param {HTMLElement} root The element the render was written into.
 * @param {Function} t vue-i18n translation method.
 */
export function enhanceContentImageZoom(root, t) {
  for (const img of root.querySelectorAll('img:not([data-content-zoom])')) {
    if (img.closest('a')) {
      img.dataset.contentZoom = 'skipped'
      continue
    }
    img.dataset.contentZoom = 'active'
    img.addEventListener('click', () => openLightbox(img.src, img.alt, t))
  }
}

/**
 * Test-only: drop the lazily-created dialog and all module state, so a fresh test does not inherit
 * another test's DOM node or open lightbox. Same convention as `blocks/shared/site.js`'s
 * `_resetSiteCache()`.
 */
export function _resetContentImageZoom() {
  dialogEl?.remove()
  dialogEl = null
  stageEl = null
  imgEl = null
  scale = ZOOM_MIN
  translateX = 0
  translateY = 0
  dragState = null
  pinchState = null
  heldScroll = null
}
