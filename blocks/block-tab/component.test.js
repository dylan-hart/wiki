import { afterEach, describe, expect, it } from 'vitest'

import './component.js'
import { mountBlock, resetBlockDom } from '../test/mount.js'

describe('block-tab', () => {
  afterEach(resetBlockDom)

  it('sets display: block on connect so a standalone tab (its parent block-tabs missing) still shows', async () => {
    const el = await mountBlock('block-tab')

    expect(el.style.display).toBe('block')
  })

  it('does not override a display already set by the parent block-tabs', async () => {
    const el = await mountBlock('block-tab', { attrs: { style: 'display: none' } })

    expect(el.style.display).toBe('none')
  })

  it('renders no shadow DOM -- content stays in the light DOM, styled by the page', async () => {
    const el = await mountBlock('block-tab', { html: '<p>Content</p>' })

    expect(el.shadowRoot).toBeNull()
    expect(el.querySelector('p').textContent).toBe('Content')
  })
})
