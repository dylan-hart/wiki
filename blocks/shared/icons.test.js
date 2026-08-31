import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchIcon, iconImageUrl } from './icons.js'

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
