import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LANDED_CLASS, REVEAL_EVENT, scrollToAnchor } from './anchors.js'

function makeTarget(id) {
  const el = document.createElement('h2')
  el.id = id
  document.body.appendChild(el)
  el.scrollIntoView = vi.fn()
  return el
}

function setVisible(el, visible) {
  Object.defineProperty(el, 'offsetParent', {
    configurable: true,
    get: () => (visible ? document.body : null)
  })
  el.getClientRects = () => (visible ? [{}] : [])
}

describe('scrollToAnchor', () => {
  let frames

  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (cb) => frames.push(cb))
    window.matchMedia = vi.fn(() => ({ matches: false }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  const runFrames = () => frames.splice(0).forEach((cb) => cb())

  it('returns false when nothing has that id', () => {
    expect(scrollToAnchor('#nope')).toBe(false)
    expect(frames).toHaveLength(0)
  })

  it('lands synchronously on a visible target without scheduling a retry', () => {
    const el = makeTarget('open')
    setVisible(el, true)

    expect(scrollToAnchor('#open')).toBe(true)

    expect(el.scrollIntoView).toHaveBeenCalledTimes(1)
    expect(el.classList.contains(LANDED_CLASS)).toBe(true)
    expect(frames).toHaveLength(0)
  })

  it('retries a frame later when the reveal only takes effect asynchronously', () => {
    const el = makeTarget('closed')
    setVisible(el, false)
    el.addEventListener(REVEAL_EVENT, () => {
      frames.push(() => setVisible(el, true))
    })

    expect(scrollToAnchor('#closed', { smooth: true })).toBe(true)
    expect(el.scrollIntoView).not.toHaveBeenCalled()

    runFrames()

    expect(el.scrollIntoView).toHaveBeenCalledTimes(1)
    expect(el.classList.contains(LANDED_CLASS)).toBe(true)
  })

  it('claims the click but does nothing when the target is still hidden after the retry', () => {
    const el = makeTarget('stuck')
    setVisible(el, false)

    expect(scrollToAnchor('#stuck')).toBe(true)
    runFrames()

    expect(el.scrollIntoView).not.toHaveBeenCalled()
    expect(el.classList.contains(LANDED_CLASS)).toBe(false)
  })
})
