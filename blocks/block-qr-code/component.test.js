import { afterEach, describe, expect, it, vi } from 'vitest'

/*
 * OpenProject #1638: the "too long" message resolves through `../shared/i18n.js`'s `I18n` reactive
 * controller rather than a hardcoded literal -- see `block-youtube/component.test.js` for the same
 * mocking rationale (`I18n` has its own dedicated coverage in `shared/i18n.test.js`).
 */
const { i18nT, MockI18n } = vi.hoisted(() => {
  const i18nT = vi.fn((_key, fallback) => fallback)
  class MockI18n {
    constructor(host) {
      this.host = host
      this.t = i18nT
    }
  }
  return { i18nT, MockI18n }
})
vi.mock('../shared/i18n.js', () => ({ I18n: MockI18n }))

import './component.js'
import { describeDarkMode } from '../test/darkMode.js'
import { mountBlock, resetBlockDom } from '../test/mount.js'

const mountQrCode = (props = {}) => mountBlock('block-qr-code', { props })

describe('block-qr-code', () => {
  afterEach(() => {
    resetBlockDom()
    i18nT.mockClear()
  })

  it('encodes the given value as an SVG code', async () => {
    const el = await mountQrCode({ value: 'https://example.com' })

    expect(el.shadowRoot.querySelector('.qr svg')).not.toBeNull()
    expect(el.shadowRoot.querySelector('.error')).toBeNull()
  })

  it('falls back to the current page address when value is empty', async () => {
    const withValue = await mountQrCode({ value: 'https://example.com/a' })
    const withoutValue = await mountQrCode({ value: '' })

    // -> Both encode something, and an explicit value produces a different code than the page's own
    //    default address (window.location in jsdom's default test origin)
    expect(withValue.shadowRoot.querySelector('svg').outerHTML).not.toBe(
      withoutValue.shadowRoot.querySelector('svg').outerHTML
    )
  })

  it('shows the caption under the code only when one is given', async () => {
    const withCaption = await mountQrCode({ value: 'x', caption: 'Scan me' })
    const withoutCaption = await mountQrCode({ value: 'x' })

    expect(withCaption.shadowRoot.querySelector('.caption').textContent).toBe('Scan me')
    expect(withoutCaption.shadowRoot.querySelector('.caption')).toBeNull()
  })

  it('clamps the size to the 80-600px range', async () => {
    const tooSmall = await mountQrCode({ value: 'x', size: 10 })
    const tooBig = await mountQrCode({ value: 'x', size: 10000 })
    const normal = await mountQrCode({ value: 'x', size: 240 })

    expect(tooSmall.shadowRoot.querySelector('.qr').getAttribute('style')).toContain(
      '--qr-size: 80px'
    )
    expect(tooBig.shadowRoot.querySelector('.qr').getAttribute('style')).toContain(
      '--qr-size: 600px'
    )
    expect(normal.shadowRoot.querySelector('.qr').getAttribute('style')).toContain(
      '--qr-size: 240px'
    )
  })

  it('falls back to the 180px default for a non-numeric size', async () => {
    const el = await mountQrCode({ value: 'x', size: 'not-a-number' })
    expect(el.shadowRoot.querySelector('.qr').getAttribute('style')).toContain('--qr-size: 180px')
  })

  it('shows an error instead of a code for content too long to encode', async () => {
    const el = await mountQrCode({ value: 'x'.repeat(5000) })

    expect(el.shadowRoot.querySelector('svg')).toBeNull()
    expect(el.shadowRoot.querySelector('.error').textContent).toContain('too long to fit')
  })

  describe('the too-long message resolves through the shared i18n resolver, not a literal', () => {
    it('asks the resolver for the too-long key', async () => {
      await mountQrCode({ value: 'x'.repeat(5000) })

      expect(i18nT).toHaveBeenCalledWith(
        'blocks.qr-code.errors.tooLong',
        'This is too long to fit in a QR code.'
      )
    })

    it("renders whatever the resolver returns, not the component's own literal", async () => {
      i18nT.mockReturnValueOnce('Trop long pour tenir dans un QR code.')
      const el = await mountQrCode({ value: 'x'.repeat(5000) })

      expect(el.shadowRoot.querySelector('.error').textContent).toContain(
        'Trop long pour tenir dans un QR code.'
      )
      expect(el.shadowRoot.querySelector('.error').textContent).not.toContain('too long to fit')
    })
  })

  describe('accessibility', () => {
    it('marks the code wrapper as an image with a short, non-empty label', async () => {
      const el = await mountQrCode({
        value:
          'https://example.com/very/long/path?with=lots&of=query&params=to&make=sure&this=would&be=a&bad=accessible-name'
      })
      const qr = el.shadowRoot.querySelector('.qr')

      expect(qr.getAttribute('role')).toBe('img')
      const label = qr.getAttribute('aria-label')
      expect(label).toBeTruthy()
      expect(label.length).toBeLessThan(40)
    })

    it('exposes a URL value as a real, copyable link rather than plain text', async () => {
      const el = await mountQrCode({ value: 'https://example.com/page' })
      const link = el.shadowRoot.querySelector('.qr a')

      expect(link).not.toBeNull()
      expect(link.getAttribute('href')).toBe('https://example.com/page')
      expect(link.textContent).toBe('https://example.com/page')
      expect(link.classList.contains('visually-hidden')).toBe(true)
    })

    it('exposes a non-URL value as visually-hidden text, not a link', async () => {
      const el = await mountQrCode({ value: 'not a web address' })
      const hidden = el.shadowRoot.querySelector('.qr .visually-hidden')

      expect(hidden).not.toBeNull()
      expect(hidden.tagName).not.toBe('A')
      expect(hidden.textContent).toBe('not a web address')
    })

    it('exposes the page-address fallback as a link when value is empty', async () => {
      const el = await mountQrCode({ value: '' })
      const link = el.shadowRoot.querySelector('.qr a.visually-hidden')

      expect(link).not.toBeNull()
      expect(link.getAttribute('href')).toBe(`${window.location.origin}${window.location.pathname}`)
    })
  })

  describeDarkMode(() => mountQrCode({ value: 'x' }))
})
