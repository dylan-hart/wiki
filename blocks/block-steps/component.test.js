import { afterEach, describe, expect, it } from 'vitest'

import './component.js'
import { mountBlock, resetBlockDom } from '../test/mount.js'

describe('block-steps', () => {
  afterEach(resetBlockDom)

  it('sets display: block on connect', async () => {
    const el = await mountBlock('block-steps')

    expect(el.style.display).toBe('block')
  })

  it('does not override a display already set', async () => {
    const el = await mountBlock('block-steps', { attrs: { style: 'display: none' } })

    expect(el.style.display).toBe('none')
  })

  it('renders no shadow DOM -- the list stays in the light DOM', async () => {
    const el = await mountBlock('block-steps', { html: '<ol><li>One</li></ol>' })

    expect(el.shadowRoot).toBeNull()
    expect(el.querySelector('li').textContent).toBe('One')
  })

  it('carries an ordered list start onto the cardinal-step counter', async () => {
    const el = await mountBlock('block-steps', {
      html: '<ol start="4"><li>Four</li><li>Five</li></ol>'
    })

    expect(el.querySelector('ol').style.getPropertyValue('counter-reset')).toBe('cardinal-step 3')
  })

  it('leaves a list with no start attribute alone', async () => {
    const el = await mountBlock('block-steps', { html: '<ol><li>One</li></ol>' })

    expect(el.querySelector('ol').style.getPropertyValue('counter-reset')).toBe('')
    expect(el.querySelector('ol').hasAttribute('style')).toBe(false)
  })

  it('leaves a list whose start is not a number alone', async () => {
    const el = await mountBlock('block-steps', { html: '<ol start="abc"><li>One</li></ol>' })

    expect(el.querySelector('ol').style.getPropertyValue('counter-reset')).toBe('')
  })

  it('only reads a list that is a direct child', async () => {
    const el = await mountBlock('block-steps', {
      html: '<div><ol start="4"><li>Four</li></ol></div>'
    })

    expect(el.querySelector('ol').style.getPropertyValue('counter-reset')).toBe('')
  })
})
