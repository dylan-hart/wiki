import { afterEach, describe, expect, it } from 'vitest'

import './component.js'
import { mountBlock, resetBlockDom } from '../test/mount.js'

/**
 * Appends a `<block-m365-video>` with `embed` set as a JS property, the way an author's saved prop
 * value arrives, and waits for Lit's first render.
 */
const mountPlayer = (embed = '') => mountBlock('block-m365-video', { props: { embed } })

const SHAREPOINT_SRC =
  'https://contoso-my.sharepoint.com/personal/jane_contoso_com/_layouts/15/embed.aspx?UniqueId=abc123&embed=%7B%22ust%22%3Atrue%7D'
const STREAM_SRC = 'https://stream.microsoft.com/embed/video/abc-123-def'
const LEGACY_STREAM_SRC = 'https://web.microsoftstream.com/embed/video/abc-123-def'
const CLIPCHAMP_SRC = 'https://clipchamp.com/watch/abc123/embed'

describe('block-m365-video', () => {
  afterEach(resetBlockDom)

  it('shows a placeholder message when no embed code has been pasted', async () => {
    const el = await mountPlayer('')

    expect(el.shadowRoot.querySelector('iframe')).toBeNull()
    expect(el.shadowRoot.querySelector('.error')?.textContent).toContain('embed code')
  })

  it('renders a lazy-loaded iframe for a bare SharePoint embed src', async () => {
    const el = await mountPlayer(SHAREPOINT_SRC)

    const iframe = el.shadowRoot.querySelector('iframe')
    expect(iframe).not.toBeNull()
    expect(iframe.getAttribute('src')).toBe(SHAREPOINT_SRC)
    expect(iframe.getAttribute('loading')).toBe('lazy')
  })

  it('extracts the src from a full iframe snippet', async () => {
    const snippet = `<iframe width="640" height="360" src="${STREAM_SRC}" frameborder="0" scrolling="no" allowfullscreen title="Video"></iframe>`
    const el = await mountPlayer(snippet)

    expect(el.shadowRoot.querySelector('iframe').getAttribute('src')).toBe(STREAM_SRC)
  })

  it('extracts the src from a snippet using single-quoted attributes', async () => {
    const snippet = `<iframe src='${STREAM_SRC}' allowfullscreen></iframe>`
    const el = await mountPlayer(snippet)

    expect(el.shadowRoot.querySelector('iframe').getAttribute('src')).toBe(STREAM_SRC)
  })

  it('extracts the src from a snippet whose attributes are split across line breaks', async () => {
    const snippet = `<iframe\n  width="640"\n  height="360"\n  src="${STREAM_SRC}"\n  allowfullscreen></iframe>`
    const el = await mountPlayer(snippet)

    expect(el.shadowRoot.querySelector('iframe').getAttribute('src')).toBe(STREAM_SRC)
  })

  it('accepts the legacy microsoftstream.com domain', async () => {
    const el = await mountPlayer(LEGACY_STREAM_SRC)

    expect(el.shadowRoot.querySelector('iframe').getAttribute('src')).toBe(LEGACY_STREAM_SRC)
  })

  it('accepts a clipchamp.com domain', async () => {
    const el = await mountPlayer(CLIPCHAMP_SRC)

    expect(el.shadowRoot.querySelector('iframe').getAttribute('src')).toBe(CLIPCHAMP_SRC)
  })

  it('accepts a protocol-relative src', async () => {
    const el = await mountPlayer('//stream.microsoft.com/embed/video/abc-123-def')

    expect(el.shadowRoot.querySelector('iframe').getAttribute('src')).toBe(
      '//stream.microsoft.com/embed/video/abc-123-def'
    )
  })

  it('rejects a non-Microsoft host instead of rendering it', async () => {
    const el = await mountPlayer('https://evil.example.com/video')

    expect(el.shadowRoot.querySelector('iframe')).toBeNull()
    const error = el.shadowRoot.querySelector('.error')?.textContent ?? ''
    expect(error).toContain('evil.example.com')
    expect(error.toLowerCase()).toContain('microsoft')
  })

  it('rejects a lookalike host that only ends with the allowed domain as a substring', async () => {
    const el = await mountPlayer('https://evil-sharepoint.com.attacker.net/video')

    expect(el.shadowRoot.querySelector('iframe')).toBeNull()
    expect(el.shadowRoot.querySelector('.error')).not.toBeNull()
  })

  it('rejects a lookalike host with no dot boundary before the allowed suffix', async () => {
    const el = await mountPlayer('https://notsharepoint.com/video')

    expect(el.shadowRoot.querySelector('iframe')).toBeNull()
    expect(el.shadowRoot.querySelector('.error')).not.toBeNull()
  })

  it('rejects a snippet with no extractable src', async () => {
    const el = await mountPlayer('<iframe width="640" height="360"></iframe>')

    expect(el.shadowRoot.querySelector('iframe')).toBeNull()
    expect(el.shadowRoot.querySelector('.error')).not.toBeNull()
  })

  it('rejects a non-https scheme', async () => {
    const el = await mountPlayer('javascript:alert(1)')

    expect(el.shadowRoot.querySelector('iframe')).toBeNull()
    expect(el.shadowRoot.querySelector('.error')).not.toBeNull()
  })

  it('carries width and height props into the player size', async () => {
    const el = await mountPlayer(STREAM_SRC)
    el.width = 640
    el.height = 480
    await el.updateComplete

    const style = el.shadowRoot.querySelector('.player').getAttribute('style')
    expect(style).toContain('width: 640px')
    expect(style).toContain('height: 480px')
  })

  it('falls back to a widescreen aspect ratio with no height given', async () => {
    const el = await mountPlayer(STREAM_SRC)

    const style = el.shadowRoot.querySelector('.player').getAttribute('style')
    expect(style).toContain('aspect-ratio: 16 / 9')
  })

  /*
   * Deliberately no `describeDarkMode` here: this block adds no `DarkMode` controller of its own and
   * `shared/video-embed.js` constructs none either -- there is nothing in a Microsoft 365 frame for
   * a `dark` attribute to restyle. See `shared/video-embed.test.js` for the full split.
   */
  it('never takes a dark attribute -- the shared video shell constructs no DarkMode controller', async () => {
    document.body.classList.add('body--dark')
    const el = await mountPlayer(STREAM_SRC)

    expect(el.hasAttribute('dark')).toBe(false)
  })
})
