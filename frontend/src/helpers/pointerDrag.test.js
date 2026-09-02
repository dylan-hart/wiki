import { describe, expect, it, vi } from 'vitest'

import { trackPointerDrag } from './pointerDrag'

/**
 * A stand-in for the element the gesture is captured on. jsdom implements neither
 * `setPointerCapture` nor `releasePointerCapture`, which is the very case the helper guards.
 */
function makeElement({ captureThrows = false } = {}) {
  const el = document.createElement('div')
  el.setPointerCapture = vi.fn(() => {
    if (captureThrows) {
      throw new Error('not a real pointer')
    }
  })
  el.releasePointerCapture = vi.fn(() => {
    if (captureThrows) {
      throw new Error('not a real pointer')
    }
  })
  return el
}

const pointerEvent = (type, init = {}) => new Event(type, { bubbles: false, ...init })

describe('trackPointerDrag', () => {
  it('routes the rest of the gesture to the element', () => {
    const el = makeElement()
    trackPointerDrag({ pointerId: 7 }, el, () => {})
    expect(el.setPointerCapture).toHaveBeenCalledWith(7)
  })

  it('reports every pointermove until the gesture ends', () => {
    const el = makeElement()
    const onMove = vi.fn()
    trackPointerDrag({ pointerId: 1 }, el, onMove)
    el.dispatchEvent(pointerEvent('pointermove'))
    el.dispatchEvent(pointerEvent('pointermove'))
    expect(onMove).toHaveBeenCalledTimes(2)
  })

  it('stops listening once the pointer is released', () => {
    const el = makeElement()
    const onMove = vi.fn()
    trackPointerDrag({ pointerId: 1 }, el, onMove)
    el.dispatchEvent(pointerEvent('pointerup'))
    el.dispatchEvent(pointerEvent('pointermove'))
    expect(onMove).not.toHaveBeenCalled()
    expect(el.releasePointerCapture).toHaveBeenCalledWith(1)
  })

  it('ends the gesture on pointercancel too', () => {
    const el = makeElement()
    const onMove = vi.fn()
    trackPointerDrag({ pointerId: 1 }, el, onMove)
    el.dispatchEvent(pointerEvent('pointercancel'))
    el.dispatchEvent(pointerEvent('pointermove'))
    expect(onMove).not.toHaveBeenCalled()
  })

  it('drags on regardless when capture is refused for a synthetic pointer', () => {
    const el = makeElement({ captureThrows: true })
    const onMove = vi.fn()
    expect(() => trackPointerDrag({ pointerId: 1 }, el, onMove)).not.toThrow()
    el.dispatchEvent(pointerEvent('pointermove'))
    expect(onMove).toHaveBeenCalledTimes(1)
    expect(() => el.dispatchEvent(pointerEvent('pointerup'))).not.toThrow()
  })

  it('hands the move event straight to the caller', () => {
    const el = makeElement()
    const onMove = vi.fn()
    trackPointerDrag({ pointerId: 1 }, el, onMove)
    const move = pointerEvent('pointermove')
    el.dispatchEvent(move)
    expect(onMove).toHaveBeenCalledWith(move)
  })
})
