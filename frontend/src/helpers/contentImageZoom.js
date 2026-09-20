/**
 * Click-to-zoom for ordinary content images: one shared, lazily-created full-viewport `<dialog>`
 * showing the image's own `src`, since there is no thumbnail/responsive variant to prefer instead.
 *
 * Deliberately not `blocks/shared/lightbox.js`'s `LightboxController`, conceptually the same
 * primitive: that is a Lit `ReactiveController` and needs a `ReactiveElement` host to attach to.
 * Content here arrives as plain DOM written by `v-html`, and `frontend/` has no `lit` dependency --
 * adding one would cross the workspace boundary. This keeps the same shell contract (full-viewport
 * `<dialog>`, backdrop, native Escape, scroll lock while open) in plain DOM instead.
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
 * The scrollable ancestor that actually moves when the reader scrolls, held still while the lightbox
 * is open. `blocks/shared/lightbox.js` and `helpers/anchors.js` each keep their own copy of this:
 * the three sit in two independently-installed workspaces with no shared module boundary.
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

/** Pointer Events cover mouse, pen and single-finger touch alike: one pan for all three. */
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

function touchDistance(touches) {
  const [a, b] = touches
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

/**
 * Pinch-to-zoom stays on raw `Touch` events rather than folding into the Pointer-Events pan above:
 * each touch of a pinch also fires its own `pointerdown`/`pointermove`, and gating on
 * `ev.touches.length === 2` keeps the two gestures apart without either API suppressing the other.
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

/** `t` is read once, for the controls' labels: the locale cannot change without a full reload. */
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
 * Idempotent: the `data-content-zoom` marker keeps a later pass over unchanged content from adding a
 * second listener. An image inside a link (markdown's `[![alt](img)](href)`) is marked but left
 * unwired, so clicking it keeps following the link rather than losing it to the lightbox.
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

/** Test-only: the dialog and the zoom state are module-level, so a test would inherit the last. */
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
