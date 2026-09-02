import { afterEach, describe, expect, it } from 'vitest'

import './component.js'
import { describeDarkMode } from '../test/darkMode.js'
import { mountBlock, resetBlockDom } from '../test/mount.js'

/**
 * Appends a `<block-dailymotion>` with `url` and any other props set, and waits for Lit's first
 * render.
 */
const mountPlayer = (url, props = {}) =>
  mountBlock('block-dailymotion', { props: url === undefined ? props : { url, ...props } })

describe('block-dailymotion', () => {
  afterEach(resetBlockDom)

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

  describeDarkMode(() => mountPlayer('x7tgcev'))
})
