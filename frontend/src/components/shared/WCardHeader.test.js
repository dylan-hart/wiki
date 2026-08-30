import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WCardHeader from './WCardHeader.vue'

/**
 * OpenProject #1633: this used to be a hardcoded `<div>`, so a card/dialog heading contributed
 * nothing to the document's heading hierarchy. `level` picks the rendered element -- default `h2`
 * for the common case (one level under a page's own `<h1>`), with `h3`-`h6` available for a header
 * nested deeper in the hierarchy.
 */
describe('WCardHeader level prop', () => {
  it('renders as an <h2> by default', () => {
    const wrapper = mount(WCardHeader, { slots: { default: 'Site info' } })

    expect(wrapper.element.tagName).toBe('H2')
    expect(wrapper.text()).toContain('Site info')
  })

  it.each(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])(
    'renders as a <%s> when level is set to it',
    (level) => {
      const wrapper = mount(WCardHeader, {
        props: { level },
        slots: { default: 'Section' }
      })

      expect(wrapper.element.tagName).toBe(level.toUpperCase())
    }
  )

  it('keeps its typography classes regardless of the chosen level', () => {
    const wrapper = mount(WCardHeader, {
      props: { level: 'h4' },
      slots: { default: 'Section' }
    })

    expect(wrapper.classes()).toContain('w-card-header')
    expect(wrapper.classes()).toContain('w-section-header')
  })

  it('still renders the hint and action slots inside the heading element', () => {
    const wrapper = mount(WCardHeader, {
      props: { level: 'h3' },
      slots: {
        default: 'Site info',
        hint: 'Shown in the browser tab',
        action: '<button>Reset</button>'
      }
    })

    expect(wrapper.find('.w-card-header__hint').text()).toBe('Shown in the browser tab')
    expect(wrapper.find('.w-card-header__action').exists()).toBe(true)
    expect(wrapper.element.tagName).toBe('H3')
  })
})
