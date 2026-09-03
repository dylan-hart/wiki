import { render } from 'lit'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchIcon, iconImageUrl, inlineIcon, MDI_PATHS } from './icons.js'

/*
 * OpenProject #1768: `fetchIcon` splits a reference on `:` and asks `/_icons/<prefix>/<name>.svg`
 * for it. An `img:` reference is `iconImageUrl()`'s to resolve instead -- it names a file to point
 * an `<img>` at, not an Iconify icon -- so `fetchIcon` must reject it up front rather than turning
 * it into a 404 that resolves to `''` and gets cached under that reference for the rest of the page
 * load (poisoning every later read of the same reference, `img:` or not, since the cache never
 * distinguishes why an entry is empty).
 */
describe('shared/icons.js: fetchIcon()', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("returns '' for an img: reference without issuing a fetch", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await fetchIcon('img:/_assets/icons/foo.png')

    expect(result).toBe('')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not cache the img: reference -- a later call still issues no fetch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    await fetchIcon('img:/_assets/icons/bar.png')
    await fetchIcon('img:/_assets/icons/bar.png')

    // -> Two calls, neither one a fetch: nothing was ever cached under this reference to satisfy
    //    the second call from, because the whole point is that `fetchIcon` never gets that far.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('still fetches and caches a real Iconify reference', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue({ ok: true, text: async () => '<svg>mdi:home</svg>' })
    vi.stubGlobal('fetch', fetchSpy)

    const first = await fetchIcon('mdi:home-1768')
    const second = await fetchIcon('mdi:home-1768')

    expect(first).toBe('<svg>mdi:home</svg>')
    expect(second).toBe('<svg>mdi:home</svg>')
    // -> One fetch for both calls: the second is served from `iconCache`.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledWith('/_icons/mdi/home-1768.svg')
  })
})

describe('shared/icons.js: iconImageUrl()', () => {
  it('extracts the address from an img: reference', () => {
    expect(iconImageUrl('img:/_assets/icons/foo.png')).toBe('/_assets/icons/foo.png')
  })

  it('returns null for a non-image reference', () => {
    expect(iconImageUrl('mdi:home')).toBeNull()
  })
})

/*
 * `block-pdf` and `block-gallery` both draw a handful of MDI glyphs straight from their path data
 * rather than through `fetchIcon`: their toolbar/lightbox chrome must be on screen the moment the
 * block renders, with no request in the way, and the two blocks had copied the same paths and the
 * same one-line `_icon()` helper into each of themselves.
 */
describe('shared/icons.js: MDI_PATHS and inlineIcon()', () => {
  it('carries the six glyphs the two chrome-drawing blocks share', () => {
    expect(Object.keys(MDI_PATHS).sort()).toEqual([
      'close',
      'next',
      'open',
      'previous',
      'zoomIn',
      'zoomOut'
    ])
    for (const path of Object.values(MDI_PATHS)) {
      expect(path).toMatch(/^M/)
    }
  })

  it('draws a path as a 24x24 svg that is invisible to assistive tech', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    render(inlineIcon(MDI_PATHS.close), host)

    const svg = host.querySelector('svg')
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.querySelector('path').getAttribute('d')).toBe(MDI_PATHS.close)

    document.body.innerHTML = ''
  })
})
