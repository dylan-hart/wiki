import { afterEach, describe, expect, it, vi } from 'vitest'

import { describeDarkMode } from '../test/darkMode.js'
import { mountBlock, resetBlockDom } from '../test/mount.js'

/*
  jsdom implements neither `IntersectionObserver` nor `ResizeObserver`, and `_setupObservers()`
  constructs both in `firstUpdated()` -- so mounting this block at all throws in this environment
  without them. Stubbed rather than worked around, the same way `pdfjs-dist` is mocked below and
  `block-diagram`'s suite polyfills the two SVG measurement calls mermaid reaches for: what the
  observers drive (lazy page rendering, re-fitting on a resize) is the real viewer, which jsdom
  cannot lay out in the first place.
*/
globalThis.IntersectionObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/*
  `pdfjs-dist/build/pdf.mjs` pulls in a canvas backend that reads `DOMMatrix` at module-eval time --
  jsdom (this workspace's pinned 30.0.1) does not implement it, so even IMPORTING the real module
  throws before a single test runs (confirmed directly: `ReferenceError: DOMMatrix is not defined`).
  Mocked here, the same way block-asciinema's real renderer is kept out of this environment's gaps --
  `_parseZoom`/`_openingPage` are pure logic with no actual dependency on pdf.js itself, which is what
  makes testing them through a stub rather than the real library the right trade.
*/
vi.mock('pdfjs-dist/build/pdf.mjs', () => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: {},
  OutputScale: class {},
  PasswordException: class PasswordException extends Error {},
  RenderingCancelledException: class RenderingCancelledException extends Error {},
  TextLayer: class {}
}))

const { BlockPdfElement } = await import('./component.js')

describe('block-pdf', () => {
  afterEach(resetBlockDom)

  it('registers itself as a custom element', () => {
    expect(customElements.get('block-pdf')).toBe(BlockPdfElement)
  })

  describe('_parseZoom', () => {
    it.each([
      ['page-fit', 'page-fit'],
      ['page-width', 'page-width'],
      ['', 'page-width'],
      [null, 'page-width'],
      ['not-a-number', 'page-width']
    ])('reads %j as %j', (input, expected) => {
      const el = new BlockPdfElement()
      expect(el._parseZoom(input)).toBe(expected)
    })

    it.each([
      ['150%', 1.5],
      ['150', 1.5], // -> the % sign is optional
      ['100%', 1]
    ])('reads a percentage %j as a scale of %j', (input, expected) => {
      const el = new BlockPdfElement()
      expect(el._parseZoom(input)).toBe(expected)
    })

    it('clamps a percentage below MIN_SCALE (10%) up to it', () => {
      const el = new BlockPdfElement()
      expect(el._parseZoom('1%')).toBe(0.1)
    })

    it('clamps a percentage above MAX_SCALE (1000%) down to it', () => {
      const el = new BlockPdfElement()
      expect(el._parseZoom('50000%')).toBe(10)
    })

    it('falls back to page-width for zero or a negative percentage rather than erroring', () => {
      const el = new BlockPdfElement()
      expect(el._parseZoom('0%')).toBe('page-width')
      expect(el._parseZoom('-50%')).toBe('page-width')
    })
  })

  describe('_openingPage', () => {
    it('opens at the requested page when it is within the document', () => {
      const el = new BlockPdfElement()
      el._pageCount = 10
      el.page = 5
      expect(el._openingPage()).toBe(5)
    })

    it('clamps a page past the end of the document down to the last page', () => {
      const el = new BlockPdfElement()
      el._pageCount = 10
      el.page = 999
      expect(el._openingPage()).toBe(10)
    })

    it('clamps a page below 1 up to the first page', () => {
      const el = new BlockPdfElement()
      el._pageCount = 10
      el.page = 0
      expect(el._openingPage()).toBe(1)
    })

    it('truncates a fractional page rather than rounding it', () => {
      const el = new BlockPdfElement()
      el._pageCount = 10
      el.page = 3.9
      expect(el._openingPage()).toBe(3)
    })

    it('falls back to page 1 for a non-numeric page prop', () => {
      const el = new BlockPdfElement()
      el._pageCount = 10
      el.page = 'not-a-page'
      expect(el._openingPage()).toBe(1)
    })
  })

  // -> Mounted with no `src`, which lands in the "this viewer needs an address" state rather than
  //    touching the mocked pdf.js at all -- the controller is constructed either way.
  describeDarkMode(() => mountBlock('block-pdf'))
})
