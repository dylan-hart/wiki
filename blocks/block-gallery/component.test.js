import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import './component.js'

/**
 * Appends a `<block-gallery>` carrying `body` as its light-DOM content (the way the wiki's own
 * markdown renderer leaves it — one address per line) and waits for Lit's first render.
 */
async function mountGallery(body = '') {
  const el = document.createElement('block-gallery')
  el.textContent = body
  document.body.appendChild(el)
  await el.updateComplete
  return el
}

describe('block-gallery', () => {
  afterEach(() => {
    document.body.replaceChildren()
    document.body.className = ''
  })

  it('reads the body, one address per line, into a grid of tiles', async () => {
    const el = await mountGallery('/photos/one.jpg\n/photos/two.jpg')

    const tiles = el.shadowRoot.querySelectorAll('.tile')
    expect(tiles).toHaveLength(2)
    expect(tiles[0].querySelector('img').getAttribute('src')).toBe('/_files/photos/one.jpg')
    expect(tiles[1].querySelector('img').getAttribute('src')).toBe('/_files/photos/two.jpg')
  })

  it('shows an empty-state message when the body has no addresses', async () => {
    const el = await mountGallery('   ')

    expect(el.shadowRoot.querySelector('.error')).not.toBeNull()
    expect(el.shadowRoot.querySelector('.gallery')).toBeNull()
  })

  it('carries the thumbnailSize prop into the grid style', async () => {
    const el = await mountGallery('/photos/one.jpg')
    el.thumbnailSize = 240
    await el.updateComplete

    expect(el.shadowRoot.querySelector('.gallery').getAttribute('style')).toContain(
      '--gallery-thumb: 240px'
    )
  })

  it('adds is-unlocked to the grid when unlockAspectRatio is on', async () => {
    const el = await mountGallery('/photos/one.jpg')
    el.unlockAspectRatio = true
    await el.updateComplete

    expect(el.shadowRoot.querySelector('.gallery').classList.contains('is-unlocked')).toBe(true)
  })

  describe('dark mode', () => {
    beforeEach(() => {
      document.body.classList.remove('body--dark')
    })

    it('follows body--dark on mount and on later toggles, via the shared DarkMode controller', async () => {
      document.body.classList.add('body--dark')
      const el = await mountGallery('/photos/one.jpg')

      expect(el.hasAttribute('dark')).toBe(true)

      document.body.classList.remove('body--dark')
      // -> The controller reacts to a MutationObserver callback, which runs as a microtask
      await new Promise((resolve) => queueMicrotask(resolve))
      await el.updateComplete

      expect(el.hasAttribute('dark')).toBe(false)
    })
  })
})
