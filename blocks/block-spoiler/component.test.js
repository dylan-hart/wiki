import { afterEach, describe, expect, it } from 'vitest'

import './component.js'

/**
 * Appends a `<block-spoiler>` with the given light-DOM content, and waits for Lit's first render.
 */
async function mountSpoiler(content = 'secret content') {
  const el = document.createElement('block-spoiler')
  el.textContent = content
  document.body.appendChild(el)
  await el.updateComplete
  return el
}

describe('block-spoiler', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('starts covered with aria-expanded reflecting the collapsed state', async () => {
    const el = await mountSpoiler()

    const button = el.shadowRoot.querySelector('.cover')
    expect(button).not.toBeNull()
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('points aria-controls at the content div, which carries a matching id', async () => {
    const el = await mountSpoiler()

    const button = el.shadowRoot.querySelector('.cover')
    const content = el.shadowRoot.querySelector('.content')

    expect(content.id).toBeTruthy()
    expect(button.getAttribute('aria-controls')).toBe(content.id)
  })

  it('removes the cover and moves focus into the content when clicked', async () => {
    const el = await mountSpoiler()

    const button = el.shadowRoot.querySelector('.cover')
    const contentId = el.shadowRoot.querySelector('.content').id

    button.click()
    await el.updateComplete

    expect(el.shadowRoot.querySelector('.cover')).toBeNull()
    const content = el.shadowRoot.querySelector('.content')
    expect(content.id).toBe(contentId)
    expect(el.shadowRoot.activeElement).toBe(content)
  })
})
