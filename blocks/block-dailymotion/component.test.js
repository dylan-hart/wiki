import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import './component.js'

/**
 * Appends a `<block-dailymotion>` with `url` and any other props set, and waits for Lit's first
 * render.
 */
async function mountPlayer(url, props = {}) {
  const el = document.createElement('block-dailymotion')
  if (url !== undefined) {
    el.url = url
  }
  for (const [key, value] of Object.entries(props)) {
    el[key] = value
  }
  document.body.appendChild(el)
  await el.updateComplete
  return el
}

describe('block-dailymotion', () => {
  afterEach(() => {
    document.body.replaceChildren()
    document.body.className = ''
  })

  it('shows an error when url is empty or unset', async () => {
    const elUnset = await mountPlayer()
    expect(elUnset.shadowRoot.querySelector('.error')).not.toBeNull()
    expect(elUnset.shadowRoot.querySelector('iframe')).toBeNull()

    const elEmpty = await mountPlayer('   ')
    expect(elEmpty.shadowRoot.querySelector('.error')).not.toBeNull()
  })

  it('shows an error for a url that is not a Dailymotion video', async () => {
    const el = await mountPlayer('https://example.com/video/x7tgcev')
    expect(el.shadowRoot.querySelector('.error').textContent).toContain(
      'is not the address of a Dailymotion video'
    )
    expect(el.shadowRoot.querySelector('iframe')).toBeNull()
  })

  it('resolves a plain share link', async () => {
    const el = await mountPlayer('https://www.dailymotion.com/video/x7tgcev')
    expect(el.shadowRoot.querySelector('iframe').getAttribute('src')).toBe(
      'https://www.dailymotion.com/embed/video/x7tgcev'
    )
  })

  it('strips the title slug from a share link', async () => {
    const el = await mountPlayer('https://www.dailymotion.com/video/x7tgcev_some-title_tech')
    expect(el.shadowRoot.querySelector('iframe').getAttribute('src')).toBe(
      'https://www.dailymotion.com/embed/video/x7tgcev'
    )
  })

  it('resolves a dai.ly short link', async () => {
    const el = await mountPlayer('https://dai.ly/x7tgcev')
    expect(el.shadowRoot.querySelector('iframe').getAttribute('src')).toBe(
      'https://www.dailymotion.com/embed/video/x7tgcev'
    )
  })

  it('resolves a share link without a scheme', async () => {
    const el = await mountPlayer('dailymotion.com/video/x7tgcev')
    expect(el.shadowRoot.querySelector('iframe').getAttribute('src')).toBe(
      'https://www.dailymotion.com/embed/video/x7tgcev'
    )
  })

  it('resolves a bare id', async () => {
    const el = await mountPlayer('x7tgcev')
    expect(el.shadowRoot.querySelector('iframe').getAttribute('src')).toBe(
      'https://www.dailymotion.com/embed/video/x7tgcev'
    )
  })

  it('sizes the frame from width and height when given', async () => {
    const el = await mountPlayer('x7tgcev', { width: 800, height: 450 })
    const style = el.shadowRoot.querySelector('.player').getAttribute('style')
    expect(style).toContain('width: 800px')
    expect(style).toContain('height: 450px')
  })

  it('falls back to a widescreen aspect ratio without an explicit height', async () => {
    const el = await mountPlayer('x7tgcev')
    const style = el.shadowRoot.querySelector('.player').getAttribute('style')
    expect(style).toContain('width: 100%')
    expect(style).toContain('aspect-ratio: 16 / 9')
  })

  it('adds autoplay and mute together, never autoplay alone', async () => {
    const el = await mountPlayer('x7tgcev', { autoplay: true })
    const src = el.shadowRoot.querySelector('iframe').getAttribute('src')
    expect(src).toContain('autoplay=true')
    expect(src).toContain('mute=true')
  })

  it('omits controls=false by default and adds it when controls is turned off', async () => {
    const shown = await mountPlayer('x7tgcev')
    expect(shown.shadowRoot.querySelector('iframe').getAttribute('src')).not.toContain('controls')

    const hidden = await mountPlayer('x7tgcev', { controls: false })
    expect(hidden.shadowRoot.querySelector('iframe').getAttribute('src')).toContain(
      'controls=false'
    )
  })

  it('adds loop=true only when loop is enabled', async () => {
    const el = await mountPlayer('x7tgcev', { loop: true })
    expect(el.shadowRoot.querySelector('iframe').getAttribute('src')).toContain('loop=true')
  })

  it('reflects fs onto the iframe allowfullscreen attribute', async () => {
    const allowed = await mountPlayer('x7tgcev')
    expect(allowed.shadowRoot.querySelector('iframe').hasAttribute('allowfullscreen')).toBe(true)

    const denied = await mountPlayer('x7tgcev', { fs: false })
    expect(denied.shadowRoot.querySelector('iframe').hasAttribute('allowfullscreen')).toBe(false)
  })

  describe('dark mode', () => {
    beforeEach(() => {
      document.body.classList.remove('body--dark')
    })

    it('follows body--dark on mount and on later toggles, via the shared DarkMode controller', async () => {
      document.body.classList.add('body--dark')
      const el = await mountPlayer('x7tgcev')

      expect(el.hasAttribute('dark')).toBe(true)

      document.body.classList.remove('body--dark')
      // -> The controller reacts to a MutationObserver callback, which runs as a microtask
      await new Promise((resolve) => queueMicrotask(resolve))
      await el.updateComplete

      expect(el.hasAttribute('dark')).toBe(false)
    })
  })
})
