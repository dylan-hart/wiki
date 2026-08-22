import { afterEach, describe, expect, it } from 'vitest'

import './component.js'

describe('block-tab', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('sets display: block on connect so a standalone tab (its parent block-tabs missing) still shows', () => {
    const el = document.createElement('block-tab')
    document.body.appendChild(el)

    expect(el.style.display).toBe('block')
  })

  it('does not override a display already set by the parent block-tabs', () => {
    const el = document.createElement('block-tab')
    el.style.display = 'none'
    document.body.appendChild(el)

    expect(el.style.display).toBe('none')
  })

  it('renders no shadow DOM -- content stays in the light DOM, styled by the page', () => {
    const el = document.createElement('block-tab')
    el.innerHTML = '<p>Content</p>'
    document.body.appendChild(el)

    expect(el.shadowRoot).toBeNull()
    expect(el.querySelector('p').textContent).toBe('Content')
  })
})
