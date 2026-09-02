import { afterEach, describe, expect, it, vi } from 'vitest'

/*
 * OpenProject #1638: the invalid-URL / missing-URL messages resolve through `../shared/i18n.js`'s
 * `I18n` reactive controller rather than a hardcoded literal. `I18n` itself has its own dedicated
 * coverage (`shared/i18n.test.js` -- resolution, English fallback, param interpolation, the
 * fallback-before-load timing); mocked here the same way `block-include`'s suite mocks
 * `../shared/config.js`, so this suite proves the component *delegates* to the resolver (calls it
 * with the right key/fallback/params, renders whatever it returns) without needing a real network
 * round trip or fetch stub.
 */
const { i18nT, MockI18n } = vi.hoisted(() => {
  // -> Mirrors the real controller's own pre-load behavior: the fallback, verbatim, until a test
  //    overrides it to prove the rendered text really is whatever the resolver hands back.
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
import { mountBlock, resetBlockDom } from '../test/mount.js'

const mountYoutube = (props = {}) => mountBlock('block-youtube', { props })

function iframeSrc(el) {
  return el.shadowRoot.querySelector('iframe')?.getAttribute('src')
}

describe('block-youtube', () => {
  afterEach(() => {
    resetBlockDom()
    i18nT.mockClear()
  })

  describe('error text resolves through the shared i18n resolver, not a literal', () => {
    it('asks the resolver for the invalid-URL key, with the URL as an interpolation param', async () => {
      await mountYoutube({ url: 'https://example.com/not-a-video' })

      expect(i18nT).toHaveBeenCalledWith(
        'blocks.youtube.errors.invalidUrl',
        'https://example.com/not-a-video is not the address of a YouTube video.',
        { url: 'https://example.com/not-a-video' }
      )
    })

    it('asks the resolver for the missing-URL key when no URL is given', async () => {
      await mountYoutube({ url: '' })

      expect(i18nT).toHaveBeenCalledWith(
        'blocks.youtube.errors.missingUrl',
        'This player needs the address of a YouTube video.'
      )
    })

    it("renders whatever the resolver returns, not the component's own literal", async () => {
      i18nT.mockReturnValueOnce("Ce n'est pas une adresse YouTube valide.")
      const el = await mountYoutube({ url: 'https://example.com/not-a-video' })

      expect(el.shadowRoot.querySelector('.error').textContent).toContain(
        "Ce n'est pas une adresse YouTube valide."
      )
      expect(el.shadowRoot.querySelector('.error').textContent).not.toContain(
        'is not the address of a YouTube video'
      )
    })
  })

  describe('videoId parsing (via the rendered embed src)', () => {
    it.each([
      ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
      ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
      ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
      ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
      ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
      ['www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'], // no scheme
      ['dQw4w9WgXcQ', 'dQw4w9WgXcQ'] // bare id
    ])('resolves %s to video id %s', async (url, id) => {
      const el = await mountYoutube({ url })
      expect(iframeSrc(el)).toContain(`/embed/${id}`)
    })

    it('shows an error, not a player, for a link that points at no video', async () => {
      const el = await mountYoutube({ url: 'https://example.com/not-a-video' })
      expect(el.shadowRoot.querySelector('iframe')).toBeNull()
      expect(el.shadowRoot.querySelector('.error').textContent).toContain(
        'is not the address of a YouTube video'
      )
    })

    it('shows the generic prompt when no URL has been given at all', async () => {
      const el = await mountYoutube({ url: '' })
      expect(el.shadowRoot.querySelector('.error').textContent).toContain(
        'This player needs the address'
      )
    })
  })

  describe('linkStart parsing (via the embed src start= param)', () => {
    it('reads a plain-seconds t= param', async () => {
      const el = await mountYoutube({ url: 'https://youtu.be/dQw4w9WgXcQ?t=90' })
      expect(iframeSrc(el)).toContain('start=90')
    })

    it('reads an Hh Mm Ss style start= param', async () => {
      const el = await mountYoutube({
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&start=1h2m3s'
      })
      expect(iframeSrc(el)).toContain(`start=${3600 + 120 + 3}`)
    })

    it('omits start= entirely when the link carries no timestamp', async () => {
      const el = await mountYoutube({ url: 'https://youtu.be/dQw4w9WgXcQ' })
      expect(iframeSrc(el)).not.toContain('start=')
    })

    it('an explicit start prop overrides whatever the URL says', async () => {
      const el = await mountYoutube({ url: 'https://youtu.be/dQw4w9WgXcQ?t=90', start: 30 })
      expect(iframeSrc(el)).toContain('start=30')
      expect(iframeSrc(el)).not.toContain('start=90')
    })
  })

  describe('embed parameters', () => {
    it('adds autoplay=1&mute=1 when autoplay is on -- muted is the only way it is allowed to play', async () => {
      const el = await mountYoutube({ url: 'https://youtu.be/dQw4w9WgXcQ', autoplay: true })
      expect(iframeSrc(el)).toContain('autoplay=1')
      expect(iframeSrc(el)).toContain('mute=1')
    })

    it('omits controls/fs params by default and sets them to 0 only when turned off', async () => {
      const defaults = await mountYoutube({ url: 'https://youtu.be/dQw4w9WgXcQ' })
      expect(iframeSrc(defaults)).not.toContain('controls=')
      expect(iframeSrc(defaults)).not.toContain('fs=')

      const off = await mountYoutube({
        url: 'https://youtu.be/dQw4w9WgXcQ',
        controls: false,
        fs: false
      })
      expect(iframeSrc(off)).toContain('controls=0')
      expect(iframeSrc(off)).toContain('fs=0')
      expect(off.shadowRoot.querySelector('iframe').hasAttribute('allowfullscreen')).toBe(false)
    })

    it('sets loop=1 and playlist=<id> together -- a single video only loops as a playlist of itself', async () => {
      const el = await mountYoutube({ url: 'https://youtu.be/dQw4w9WgXcQ', loop: true })
      expect(iframeSrc(el)).toContain('loop=1')
      expect(iframeSrc(el)).toContain('playlist=dQw4w9WgXcQ')
    })
  })

  describe('sizing', () => {
    it('fills the width and keeps a 16:9 aspect ratio with no width/height given', async () => {
      const el = await mountYoutube({ url: 'https://youtu.be/dQw4w9WgXcQ' })
      const style = el.shadowRoot.querySelector('.player').getAttribute('style')
      expect(style).toContain('width: 100%')
      expect(style).toContain('aspect-ratio: 16 / 9')
    })

    it('uses explicit pixel width/height when given', async () => {
      const el = await mountYoutube({
        url: 'https://youtu.be/dQw4w9WgXcQ',
        width: 640,
        height: 360
      })
      const style = el.shadowRoot.querySelector('.player').getAttribute('style')
      expect(style).toContain('width: 640px')
      expect(style).toContain('height: 360px')
    })
  })

  /*
   * Deliberately no `describeDarkMode` here: this block adds no `DarkMode` controller of its own and
   * `shared/video-embed.js` constructs none either -- there is nothing in a YouTube frame for a
   * `dark` attribute to restyle. See `shared/video-embed.test.js` for the full split.
   */
  it('never takes a dark attribute -- the shared video shell constructs no DarkMode controller', async () => {
    document.body.classList.add('body--dark')
    const el = await mountYoutube({ url: 'https://youtu.be/dQw4w9WgXcQ' })

    expect(el.hasAttribute('dark')).toBe(false)
  })
})
