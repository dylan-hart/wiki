/**
 * Getting to a heading inside a rendered page, which `scrollIntoView` alone cannot do: the render
 * arrives after the browser has already tried the URL's fragment, a heading can sit inside a block
 * that is not showing it (a closed tab) and so has no box, and the page goes on changing height as
 * each block fetches its component.
 */

/**
 * Asked of a block that might be hiding the element the event was dispatched on. Bubbles and crosses
 * shadow boundaries, so the app needs no knowledge of which kinds of block can hide things — a new
 * one only has to listen.
 */
export const REVEAL_EVENT = 'block-reveal'

const SAMPLE_MS = 60

const STABLE_SAMPLES = 3

const SETTLE_MS = 1200

const DRIFT_TOLERANCE = 4

/**
 * Left on whatever a fragment link landed on, for content styling to mark. Replaces `:target`, which
 * cannot serve: an in-content fragment link is followed with `router.push`, and a pushed hash does
 * not set the document's target element. Styled in `_page-contents.css` — keep the two in step.
 */
export const LANDED_CLASS = 'is-anchor-landed'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function markLanded(el) {
  for (const previous of document.querySelectorAll(`.${LANDED_CLASS}`)) {
    previous.classList.remove(LANDED_CLASS)
  }
  el.classList.add(LANDED_CLASS)
}

export function anchorTarget(hash) {
  const id = decodeURIComponent(String(hash ?? '').replace(/^#/, ''))
  // -> `getElementById` rather than a selector, which would have to escape a slug that is not a
  //    valid CSS identifier
  return id ? document.getElementById(id) : null
}

/** False while the element sits in a block panel that is not showing, and so has no box. */
function isVisible(el) {
  return Boolean(el.offsetParent ?? el.getClientRects().length)
}

function reveal(el) {
  el.dispatchEvent(new CustomEvent(REVEAL_EVENT, { bubbles: true, composed: true }))
}

function land(el, smooth) {
  if (!isVisible(el)) {
    return false
  }
  markLanded(el)
  scrollTo(el, smooth)
  return true
}

/**
 * The article has its own scroller rather than the window — the shell stays put and the column moves
 * — so the heading's position has to be read against that box, not the viewport.
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

function positionOf(el, scroller) {
  return Math.round(el.getBoundingClientRect().top + scroller.scrollTop)
}

function driftOf(el, scroller) {
  const margin = Number.parseFloat(getComputedStyle(el).scrollMarginTop) || 0
  const wanted = scroller.getBoundingClientRect().top + margin
  return el.getBoundingClientRect().top - wanted
}

function scrollTo(el, smooth) {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  el.scrollIntoView({ behavior: smooth && !reduceMotion ? 'smooth' : 'auto', block: 'start' })
}

/**
 * Blocks land after the page is drawn and change its height as they do — a set of tabs is at its
 * tallest before its component arrives, with every panel stacked up. Scrolling mid-flight leaves the
 * reader somewhere below the heading they asked for.
 */
async function whenStill(el, scroller, deadline) {
  let previous = null
  let agreed = 0
  while (performance.now() < deadline) {
    const position = positionOf(el, scroller)
    agreed = position === previous ? agreed + 1 : 0
    if (agreed >= STABLE_SAMPLES) {
      return
    }
    previous = position
    await delay(SAMPLE_MS)
  }
}

function whenScrollEnded(scroller) {
  if (!('onscrollend' in window)) {
    return delay(SETTLE_MS)
  }
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      scroller.removeEventListener('scrollend', done)
      resolve()
    }
    const timer = setTimeout(done, SETTLE_MS)
    scroller.addEventListener('scrollend', done, { once: true })
  })
}

/**
 * For a page that is already settled — a click on the contents list, say. See
 * `scrollToAnchorWhenReady` for one that has only just been rendered.
 *
 * A block asked to reveal something does not show it in this tick (`block-tabs` sets the open panel
 * and Lit draws it in its own async update), so the target may have no box yet. Hence the second
 * attempt a frame later, and hence returning true before the scroll has happened: callers use the
 * result to decide whether to claim the click, and a target that had to be revealed is still
 * somewhere to go.
 */
export function scrollToAnchor(hash, { smooth = false } = {}) {
  const target = anchorTarget(hash)
  if (!target) {
    return false
  }
  reveal(target)
  if (!land(target, smooth)) {
    requestAnimationFrame(() => land(target, smooth))
  }
  return true
}

/**
 * The same, for a page that has only just been rendered. Animated rather than jumped, so a reader
 * who followed a link into the middle of a long page sees where they were taken instead of having to
 * work out where the top went.
 */
export async function scrollToAnchorWhenReady(hash, { timeout = 5000 } = {}) {
  if (!hash) {
    return
  }
  const deadline = performance.now() + timeout

  // -> The heading itself may not exist yet: a block fetches its component, and an included page its
  //    content, after the page around them is drawn
  let target = anchorTarget(hash)
  while (performance.now() < deadline) {
    if (target) {
      reveal(target)
      if (isVisible(target)) {
        break
      }
    }
    await delay(SAMPLE_MS)
    target = anchorTarget(hash)
  }
  if (!target || !isVisible(target)) {
    return
  }
  markLanded(target)

  const scroller = scrollerOf(target)
  await whenStill(target, scroller, deadline)
  scrollTo(target, true)

  // -> One correction, without animation: the reader has already watched the page travel, and what
  //    is left is a few pixels of something that loaded on the way
  await whenScrollEnded(scroller)
  if (Math.abs(driftOf(target, scroller)) > DRIFT_TOLERANCE && isVisible(target)) {
    scrollTo(target, false)
  }
}
