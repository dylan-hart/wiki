import { css } from 'lit'
import { afterEach, describe, expect, it } from 'vitest'

import { DiagramImageElement } from './diagram-image.js'
import { DarkMode } from './theme.js'
import { playerStyles, VideoEmbedElement } from './video-embed.js'
import { mountBlock, resetBlockDom } from '../test/mount.js'

/**
 * The smallest possible subclass: the two hooks every video block has to write, and nothing else.
 *
 * Deliberately not one of the real blocks -- what is under test here is the shell they all inherit
 * (the size computation, the frame, the two error branches), not any provider's URL grammar, which
 * each block's own `component.test.js` already covers.
 */
class TestEmbedElement extends VideoEmbedElement {
  _providerName() {
    return 'Test'
  }

  _parse(source) {
    return source.trim() === 'good' ? 'abc123' : null
  }

  _embedUrl(id) {
    return `https://example.test/embed/${id}`
  }
}
customElements.define('test-video-embed', TestEmbedElement)

/** A subclass overriding the source hook the way `block-m365-video` does, off a different prop. */
class TestEmbedCodeElement extends VideoEmbedElement {
  static properties = { embed: { type: String } }

  static styles = [
    ...VideoEmbedElement.styles,
    css`
      .player {
        border: 1px solid #e0e0e0;
      }
    `
  ]

  constructor() {
    super()
    this.embed = ''
  }

  _source() {
    return (this.embed ?? '').trim()
  }

  _providerName() {
    return 'Embed Code'
  }

  _parse(source) {
    return source.startsWith('https://') ? source : null
  }

  _embedUrl(src) {
    return src
  }

  _frameAllow() {
    return 'autoplay; fullscreen'
  }
}
customElements.define('test-video-embed-code', TestEmbedCodeElement)

/** The other shared shell, for the dark-mode comparison below. Adds nothing of its own. */
class TestDiagramElement extends DiagramImageElement {}
customElements.define('test-diagram-image', TestDiagramElement)

const mount = (tag, props = {}) => mountBlock(tag, { props })

describe('shared/video-embed.js: playerStyles', () => {
  it('styles the frame box and the frame itself, leaving the error box to errorBox', () => {
    expect(playerStyles.cssText).toContain('.player')
    expect(playerStyles.cssText).toContain('iframe')
    // -> `.error`'s own box comes from `./styles.js`; only the gap below it is here
    expect(playerStyles.cssText).toContain('margin-bottom: 16px')
    expect(playerStyles.cssText).not.toContain('color-mix')
  })

  it('leaves the border vimeo and dailymotion draw to those blocks', () => {
    expect(playerStyles.cssText).not.toContain('#e0e0e0')
  })
})

describe('shared/video-embed.js: VideoEmbedElement', () => {
  afterEach(resetBlockDom)

  it('mountBlock refuses more than one of pre, text or html', async () => {
    await expect(mountBlock('test-video-embed', { pre: 'a', text: 'b' })).rejects.toThrow(
      'mountBlock: pass at most one of pre, text or html'
    )
  })

  it('adopts the shared error box alongside the player styles', () => {
    const cssText = VideoEmbedElement.styles.map((sheet) => sheet.cssText).join('\n')
    expect(cssText).toContain('color: var(--q-negative, #c10015)')
    expect(cssText).toContain('.player')
  })

  it('renders the frame for a url its subclass can parse', async () => {
    const el = await mount('test-video-embed', { url: 'good' })

    const iframe = el.shadowRoot.querySelector('iframe')
    expect(iframe.getAttribute('src')).toBe('https://example.test/embed/abc123')
    expect(iframe.getAttribute('title')).toBe('Test video player')
    expect(iframe.getAttribute('loading')).toBe('lazy')
    expect(iframe.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin')
    expect(iframe.getAttribute('allow')).toContain('picture-in-picture')
    expect(el.shadowRoot.querySelector('.error')).toBeNull()
  })

  it('shows the missing-source message for an empty or unset url', async () => {
    const unset = await mount('test-video-embed')
    expect(unset.shadowRoot.querySelector('iframe')).toBeNull()
    expect(unset.shadowRoot.querySelector('.error').textContent).toBe(
      'This player needs the address of a Test video.'
    )

    const blank = await mount('test-video-embed', { url: '   ' })
    expect(blank.shadowRoot.querySelector('.error').textContent).toBe(
      'This player needs the address of a Test video.'
    )
  })

  it('shows the invalid-source message, quoting what was given, for a url it cannot parse', async () => {
    const el = await mount('test-video-embed', { url: 'https://example.com/nope' })

    expect(el.shadowRoot.querySelector('iframe')).toBeNull()
    expect(el.shadowRoot.querySelector('.error').textContent).toBe(
      'https://example.com/nope is not the address of a Test video.'
    )
  })

  it('falls back to a widescreen aspect ratio with no width or height given', async () => {
    const el = await mount('test-video-embed', { url: 'good' })

    const style = el.shadowRoot.querySelector('.player').getAttribute('style')
    expect(style).toBe('width: 100%; aspect-ratio: 16 / 9')
  })

  it('sizes the frame in pixels from width and height when both are given', async () => {
    const el = await mount('test-video-embed', { url: 'good', width: 800, height: 450 })

    const style = el.shadowRoot.querySelector('.player').getAttribute('style')
    expect(style).toBe('width: 800px; height: 450px')
  })

  it('ignores a width or height that is not a usable number', async () => {
    const el = await mount('test-video-embed', { url: 'good', width: 0, height: 'tall' })

    const style = el.shadowRoot.querySelector('.player').getAttribute('style')
    expect(style).toBe('width: 100%; aspect-ratio: 16 / 9')
  })

  it('reflects fs onto the frame allowfullscreen attribute', async () => {
    const allowed = await mount('test-video-embed', { url: 'good' })
    expect(allowed.shadowRoot.querySelector('iframe').hasAttribute('allowfullscreen')).toBe(true)

    const denied = await mount('test-video-embed', { url: 'good', fs: false })
    expect(denied.shadowRoot.querySelector('iframe').hasAttribute('allowfullscreen')).toBe(false)
  })

  it('starts every player prop on the default its picker offers', async () => {
    const el = await mount('test-video-embed')

    expect(el.url).toBe('')
    expect(el.width).toBeNull()
    expect(el.height).toBeNull()
    expect(el.autoplay).toBe(false)
    expect(el.controls).toBe(true)
    expect(el.fs).toBe(true)
    expect(el.loop).toBe(false)
  })

  it('reads a "false" attribute as off, not as a non-empty string', async () => {
    const el = document.createElement('test-video-embed')
    el.setAttribute('controls', 'false')
    el.setAttribute('autoplay', 'true')
    document.body.appendChild(el)
    await el.updateComplete

    expect(el.controls).toBe(false)
    expect(el.autoplay).toBe(true)
  })

  describe('a subclass reading its source from another prop', () => {
    it('takes the source hook over `url`', async () => {
      const el = await mount('test-video-embed-code', { embed: '  https://example.test/x  ' })

      expect(el.shadowRoot.querySelector('iframe').getAttribute('src')).toBe(
        'https://example.test/x'
      )
    })

    it('uses its own allow list on the frame', async () => {
      const el = await mount('test-video-embed-code', { embed: 'https://example.test/x' })

      expect(el.shadowRoot.querySelector('iframe').getAttribute('allow')).toBe(
        'autoplay; fullscreen'
      )
    })

    it('still reports an empty source through the shared message', async () => {
      const el = await mount('test-video-embed-code', { embed: '   ' })

      expect(el.shadowRoot.querySelector('.error').textContent).toBe(
        'This player needs the address of a Embed Code video.'
      )
    })

    it('keeps the base styles when it adds its own', () => {
      const cssText = TestEmbedCodeElement.styles.map((sheet) => sheet.cssText).join('\n')
      expect(cssText).toContain('.player')
      expect(cssText).toContain('#e0e0e0')
    })
  })
})

/*
 * The two shared shells disagree about dark mode on purpose, and the disagreement is invisible from
 * either one on its own -- so it is pinned here, in one place, rather than being inferred from which
 * blocks happen to have a dark-mode suite.
 *
 * `DiagramImageElement` constructs a `DarkMode` controller for every block that inherits it, because
 * its own styles key off `:host([dark])` (the sheet a drawing sits on draws its border differently in
 * the two themes). `VideoEmbedElement` constructs none: a video frame is an opaque provider iframe on
 * a black box, and there is nothing in `playerStyles` for a `dark` attribute to change. So
 * `block-youtube` and `block-m365-video`, which add nothing, never get the attribute at all, while
 * `block-vimeo` and `block-dailymotion` construct their own controller for the one border they draw
 * -- see each of those four suites for the per-block half of this.
 */
describe('shared: which shell constructs a DarkMode controller', () => {
  afterEach(resetBlockDom)

  it('VideoEmbedElement constructs none, so a subclass that adds nothing takes no dark attribute', async () => {
    document.body.classList.add('body--dark')
    const el = await mount('test-video-embed', { url: 'good' })

    expect(el._darkMode).toBeUndefined()
    expect(el.hasAttribute('dark')).toBe(false)
  })

  it('DiagramImageElement constructs one, so a subclass that adds nothing follows the app theme', async () => {
    document.body.classList.add('body--dark')
    const el = await mount('test-diagram-image')

    expect(el._darkMode).toBeInstanceOf(DarkMode)
    expect(el.hasAttribute('dark')).toBe(true)
  })
})
