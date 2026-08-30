import { afterEach, describe, expect, it, vi } from 'vitest'

import { anchoredPosition } from './anchoredPosition'

/**
 * `WMenu.vue:179` delegates its own positioning to this function, so it is the purer unit to pin
 * directly — a `WMenu` positioning test would mostly just re-assert this instead.
 */

function stubViewport(width, height) {
  vi.stubGlobal('innerWidth', width)
  vi.stubGlobal('innerHeight', height)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('anchoredPosition()', () => {
  const anchorRect = { left: 100, top: 200, width: 80, height: 30 }
  const floatSize = { width: 120, height: 40 }

  it('defaults to anchoring bottom-left of the trigger to top-left of the float', () => {
    stubViewport(1024, 768)
    const { left, top } = anchoredPosition(anchorRect, floatSize, {})

    expect(left).toBe(anchorRect.left)
    expect(top).toBe(anchorRect.top + anchorRect.height)
  })

  it('anchors bottom-right of the trigger to top-right of the float', () => {
    stubViewport(1024, 768)
    const { left, top } = anchoredPosition(anchorRect, floatSize, {
      anchor: 'bottom right',
      self: 'top right'
    })

    expect(left).toBe(anchorRect.left + anchorRect.width - floatSize.width)
    expect(top).toBe(anchorRect.top + anchorRect.height)
  })

  it('applies an extra [x, y] offset on top of the anchor/self placement', () => {
    stubViewport(1024, 768)
    const { left, top } = anchoredPosition(anchorRect, floatSize, { offset: [5, 10] })

    expect(left).toBe(anchorRect.left + 5)
    expect(top).toBe(anchorRect.top + anchorRect.height + 10)
  })

  it('clamps to the left/top margin rather than letting the float run off screen', () => {
    stubViewport(1024, 768)
    const { left, top } = anchoredPosition({ left: 2, top: 2, width: 10, height: 10 }, floatSize, {
      anchor: 'top left',
      self: 'bottom right'
    })

    expect(left).toBeGreaterThanOrEqual(8)
    expect(top).toBeGreaterThanOrEqual(8)
  })

  it('clamps to the right/bottom margin rather than letting the float run off screen', () => {
    stubViewport(300, 200)
    const { left, top } = anchoredPosition(
      { left: 290, top: 190, width: 10, height: 10 },
      floatSize,
      { anchor: 'bottom right', self: 'top left' }
    )

    expect(left).toBeLessThanOrEqual(300 - floatSize.width - 8)
    expect(top).toBeLessThanOrEqual(200 - floatSize.height - 8)
  })

  it('falls back to bottom-left / top-left for an empty or malformed spec', () => {
    stubViewport(1024, 768)
    const withEmpty = anchoredPosition(anchorRect, floatSize, { anchor: '', self: '' })
    const withMalformed = anchoredPosition(anchorRect, floatSize, {
      anchor: 'nonsense value',
      self: 'also nonsense'
    })

    expect(withEmpty).toEqual({ left: anchorRect.left, top: anchorRect.top + anchorRect.height })
    expect(withMalformed).toEqual(withEmpty)
  })

  it('treats center and middle as the same 0.5 fraction on both axes', () => {
    stubViewport(1024, 768)
    const withCenter = anchoredPosition(anchorRect, floatSize, {
      anchor: 'center center',
      self: 'middle middle'
    })
    const withMiddle = anchoredPosition(anchorRect, floatSize, {
      anchor: 'middle middle',
      self: 'center center'
    })

    expect(withCenter).toEqual(withMiddle)
  })

  it('centers the float on the anchor when both anchor and self are "middle center"', () => {
    stubViewport(1024, 768)
    const { left, top } = anchoredPosition(anchorRect, floatSize, {
      anchor: 'middle center',
      self: 'middle center'
    })

    expect(left).toBe(anchorRect.left + anchorRect.width / 2 - floatSize.width / 2)
    expect(top).toBe(anchorRect.top + anchorRect.height / 2 - floatSize.height / 2)
  })
})
