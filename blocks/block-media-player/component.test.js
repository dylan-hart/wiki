import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import './component.js'

/**
 * Appends a `<block-media-player>` with `src` set, and waits for Lit's first render.
 */
async function mountPlayer(src) {
  const el = document.createElement('block-media-player')
  if (src !== undefined) {
    el.src = src
  }
  document.body.appendChild(el)
  await el.updateComplete
  return el
}

describe('block-media-player', () => {
  afterEach(() => {
    document.body.replaceChildren()
    document.body.className = ''
  })

  it('shows an error when src is empty or unset', async () => {
    const elUnset = await mountPlayer()
    expect(elUnset.shadowRoot.querySelector('.error')).not.toBeNull()
    expect(elUnset.shadowRoot.querySelector('video')).toBeNull()
    expect(elUnset.shadowRoot.querySelector('audio')).toBeNull()

    const elEmpty = await mountPlayer('   ')
    expect(elEmpty.shadowRoot.querySelector('.error')).not.toBeNull()
  })

  it('renders a video element for a video file extension', async () => {
    const el = await mountPlayer('/files/clip.mp4')

    const video = el.shadowRoot.querySelector('video.media-display')
    expect(video).not.toBeNull()
    expect(el.shadowRoot.querySelector('audio')).toBeNull()
    const source = video.querySelector('source')
    expect(source.getAttribute('src')).toBe('/files/clip.mp4')
    expect(source.getAttribute('type')).toBe('video/mp4')
  })

  it('detects webm and ogg video types', async () => {
    const elWebm = await mountPlayer('/files/clip.webm')
    expect(elWebm.shadowRoot.querySelector('source').getAttribute('type')).toBe('video/webm')

    const elOgv = await mountPlayer('/files/clip.ogv')
    expect(elOgv.shadowRoot.querySelector('source').getAttribute('type')).toBe('video/ogg')
  })

  it('renders an audio element for an audio file extension', async () => {
    const el = await mountPlayer('/files/track.mp3')

    const audio = el.shadowRoot.querySelector('audio.media-display')
    expect(audio).not.toBeNull()
    expect(el.shadowRoot.querySelector('video')).toBeNull()
    const source = audio.querySelector('source')
    expect(source.getAttribute('src')).toBe('/files/track.mp3')
    expect(source.getAttribute('type')).toBe('audio/mpeg')
  })

  it('detects wav and m4a audio types', async () => {
    const elWav = await mountPlayer('/files/track.wav')
    expect(elWav.shadowRoot.querySelector('audio')).not.toBeNull()
    expect(elWav.shadowRoot.querySelector('source').getAttribute('type')).toBe('audio/wav')

    const elM4a = await mountPlayer('/files/track.m4a')
    expect(elM4a.shadowRoot.querySelector('audio')).not.toBeNull()
    expect(elM4a.shadowRoot.querySelector('source').getAttribute('type')).toBe('audio/mp4')
  })

  it('treats an ambiguous .ogg extension as audio', async () => {
    const el = await mountPlayer('/files/track.ogg')
    expect(el.shadowRoot.querySelector('audio')).not.toBeNull()
    expect(el.shadowRoot.querySelector('source').getAttribute('type')).toBe('audio/ogg')
  })

  it('sets an error message when the media element fails to load', async () => {
    const el = await mountPlayer('/files/missing.mp4')
    const media = el.shadowRoot.querySelector('.media-display')

    media.dispatchEvent(new Event('error'))
    await el.updateComplete

    expect(el._error).toContain('/files/missing.mp4')
    expect(el.shadowRoot.querySelector('.error')).not.toBeNull()
    expect(el.shadowRoot.querySelector('.media-display')).toBeNull()
  })

  describe('dark mode', () => {
    beforeEach(() => {
      document.body.classList.remove('body--dark')
    })

    it('follows body--dark on mount and on later toggles, via the shared DarkMode controller', async () => {
      document.body.classList.add('body--dark')
      const el = await mountPlayer('/files/clip.mp4')

      expect(el.hasAttribute('dark')).toBe(true)

      document.body.classList.remove('body--dark')
      // -> The controller reacts to a MutationObserver callback, which runs as a microtask
      await new Promise((resolve) => queueMicrotask(resolve))
      await el.updateComplete

      expect(el.hasAttribute('dark')).toBe(false)
    })
  })
})
