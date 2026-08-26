import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { anchoredPosition } from './anchoredPosition.js'

/**
 * Pure positioning arithmetic -- no DOM mounting needed, just a `DOMRect`-shaped anchor and a
 * measured floating-element size. `window.innerWidth`/`innerHeight` are stubbed per test since the
 * clamping behaviour is what several of these assert on.
 */
describe('anchoredPosition', () => {
  const originalInnerWidth = window.innerWidth
  const originalInnerHeight = window.innerHeight

  beforeEach(() => {
    window.innerWidth = 1024
    window.innerHeight = 768
  })

  afterEach(() => {
    window.innerWidth = originalInnerWidth
    window.innerHeight = originalInnerHeight
  })

  it('anchors bottom-left by default: floating element top-left sits at the anchor bottom-left', () => {
    const anchorRect = { top: 100, left: 200, width: 80, height: 30 }
    const floatSize = { width: 120, height: 60 }

    const { left, top } = anchoredPosition(anchorRect, floatSize, {})

    expect(left).toBe(200)
    expect(top).toBe(130)
  })

  it('aligns "bottom right" anchor with "top right" self, right-edges flush', () => {
    const anchorRect = { top: 100, left: 200, width: 80, height: 30 }
    const floatSize = { width: 120, height: 60 }

    const { left, top } = anchoredPosition(anchorRect, floatSize, {
      anchor: 'bottom right',
      self: 'top right'
    })

    // -> Anchor's right edge is at 280; self's right edge (left + width) must land there too
    expect(left).toBe(280 - 120)
    expect(top).toBe(130)
  })

  it('centers on the anchor when both anchor and self are "center"/"middle"', () => {
    const anchorRect = { top: 100, left: 200, width: 80, height: 30 }
    const floatSize = { width: 120, height: 60 }

    const { left, top } = anchoredPosition(anchorRect, floatSize, {
      anchor: 'middle center',
      self: 'middle center'
    })

    expect(left).toBe(200 + 40 - 60)
    expect(top).toBe(100 + 15 - 30)
  })

  it('applies an extra [x, y] offset on top of the computed position', () => {
    const anchorRect = { top: 100, left: 200, width: 80, height: 30 }
    const floatSize = { width: 120, height: 60 }

    const { left, top } = anchoredPosition(anchorRect, floatSize, { offset: [5, 10] })

    expect(left).toBe(200 + 5)
    expect(top).toBe(130 + 10)
  })

  it('clamps to the left/top margin when the computed position would run off the near edge', () => {
    const anchorRect = { top: 2, left: 2, width: 10, height: 10 }
    const floatSize = { width: 120, height: 60 }

    const { left, top } = anchoredPosition(anchorRect, floatSize, {
      anchor: 'top left',
      self: 'bottom right'
    })

    expect(left).toBe(8)
    expect(top).toBe(8)
  })

  it('clamps to the right/bottom margin when the computed position would run off the far edge', () => {
    const anchorRect = { top: 760, left: 1020, width: 10, height: 10 }
    const floatSize = { width: 120, height: 60 }

    const { left, top } = anchoredPosition(anchorRect, floatSize, {
      anchor: 'bottom right',
      self: 'top left'
    })

    expect(left).toBe(window.innerWidth - floatSize.width - 8)
    expect(top).toBe(window.innerHeight - floatSize.height - 8)
  })

  it('falls back to "bottom left"/"top left" defaults for an empty or malformed spec', () => {
    const anchorRect = { top: 100, left: 200, width: 80, height: 30 }
    const floatSize = { width: 120, height: 60 }

    const { left, top } = anchoredPosition(anchorRect, floatSize, { anchor: '', self: null })

    expect(left).toBe(200)
    expect(top).toBe(130)
  })
})
