import { afterEach, describe, expect, it } from 'vitest'

import './component.js'
import { describeDarkMode } from '../test/darkMode.js'
import { mountBlock, resetBlockDom } from '../test/mount.js'

/**
 * Appends a `<block-vimeo>` with `url` and any other props set, and waits for Lit's first render.
 */
const mountPlayer = (url, props = {}) =>
  mountBlock('block-vimeo', { props: url === undefined ? props : { url, ...props } })

describe('block-vimeo', () => {
  afterEach(resetBlockDom)

  it('shows an error when url is empty or unset', async () => {
    const elUnset = await mountPlayer()
    expect(elUnset.shadowRoot.querySelector('.error')).not.toBeNull()
    expect(elUnset.shadowRoot.querySelector('iframe')).toBeNull()

    const elEmpty = await mountPlayer('   ')
    expect(elEmpty.shadowRoot.querySelector('.error')).not.toBeNull()
  })

  it('shows an error for a url that is not a Vimeo video', async () => {
    const el = await mountPlayer('https://example.com/video/123')
    expect(el.shadowRoot.querySelector('.error').textContent).toContain(
      'is not the address of a Vimeo video'
    )
    expect(el.shadowRoot.querySelector('iframe')).toBeNull()
  })

  it('resolves a plain share link', async () => {
    const el = await mountPlayer('https://vimeo.com/76979871')
    expect(el.shadowRoot.querySelector('iframe').getAttribute('src')).toBe(
      'https://player.vimeo.com/video/76979871'
    )
  })

  it('resolves a share link without a scheme', async () => {
    const el = await mountPlayer('vimeo.com/76979871')
    expect(el.shadowRoot.querySelector('iframe').getAttribute('src')).toBe(
      'https://player.vimeo.com/video/76979871'
    )
  })

  it('resolves a bare id', async () => {
    const el = await mountPlayer('76979871')
    expect(el.shadowRoot.querySelector('iframe').getAttribute('src')).toBe(
      'https://player.vimeo.com/video/76979871'
    )
  })

  it('carries the privacy hash from an unlisted share link', async () => {
    const el = await mountPlayer('https://vimeo.com/76979871/abc123def')
    expect(el.shadowRoot.querySelector('iframe').getAttribute('src')).toBe(
      'https://player.vimeo.com/video/76979871?h=abc123def'
    )
  })

  it('resolves a player.vimeo.com link, carrying its own h parameter', async () => {
    const el = await mountPlayer('https://player.vimeo.com/video/76979871?h=abc123def')
    expect(el.shadowRoot.querySelector('iframe').getAttribute('src')).toBe(
      'https://player.vimeo.com/video/76979871?h=abc123def'
    )
  })

  it('sizes the frame from width and height when given', async () => {
    const el = await mountPlayer('76979871', { width: 800, height: 450 })
    const style = el.shadowRoot.querySelector('.player').getAttribute('style')
    expect(style).toContain('width: 800px')
    expect(style).toContain('height: 450px')
  })

  it('falls back to a widescreen aspect ratio without an explicit height', async () => {
    const el = await mountPlayer('76979871')
    const style = el.shadowRoot.querySelector('.player').getAttribute('style')
    expect(style).toContain('width: 100%')
    expect(style).toContain('aspect-ratio: 16 / 9')
  })

  it('adds autoplay and mute together, never autoplay alone', async () => {
    const el = await mountPlayer('76979871', { autoplay: true })
    const src = el.shadowRoot.querySelector('iframe').getAttribute('src')
    expect(src).toContain('autoplay=1')
    expect(src).toContain('muted=1')
  })

  it('omits controls=0 by default and adds it when controls is turned off', async () => {
    const shown = await mountPlayer('76979871')
    expect(shown.shadowRoot.querySelector('iframe').getAttribute('src')).not.toContain('controls')

    const hidden = await mountPlayer('76979871', { controls: false })
    expect(hidden.shadowRoot.querySelector('iframe').getAttribute('src')).toContain('controls=0')
  })

  it('adds loop=1 only when loop is enabled', async () => {
    const el = await mountPlayer('76979871', { loop: true })
    expect(el.shadowRoot.querySelector('iframe').getAttribute('src')).toContain('loop=1')
  })

  it('reflects fs onto the iframe allowfullscreen attribute and the fullscreen embed param', async () => {
    const allowed = await mountPlayer('76979871')
    expect(allowed.shadowRoot.querySelector('iframe').hasAttribute('allowfullscreen')).toBe(true)
    expect(allowed.shadowRoot.querySelector('iframe').getAttribute('src')).not.toContain(
      'fullscreen'
    )

    const denied = await mountPlayer('76979871', { fs: false })
    expect(denied.shadowRoot.querySelector('iframe').hasAttribute('allowfullscreen')).toBe(false)
    expect(denied.shadowRoot.querySelector('iframe').getAttribute('src')).toContain('fullscreen=0')
  })

  describeDarkMode(() => mountPlayer('76979871'))
})
