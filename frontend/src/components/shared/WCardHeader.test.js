import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WCardHeader from './WCardHeader.vue'

/**
 * OpenProject #1617: `WCardHeader` mints an id with `useId()` and exposes it, so a `WDialog`
 * wrapping it can bind that id as `labelled-by` and reuse the heading text already on screen
 * instead of duplicating it into a separate `aria-label`.
 */
describe('WCardHeader accessible-name plumbing', () => {
  it('exposes a non-empty headingId that lands on the element wrapping the heading text', () => {
    const wrapper = mount(WCardHeader, {
      slots: { default: 'Site info' }
    })

    const headingId = wrapper.vm.headingId
    expect(headingId).toBeTruthy()

    const heading = wrapper.find(`#${headingId}`)
    expect(heading.exists()).toBe(true)
    expect(heading.text()).toBe('Site info')
  })

  it('keeps the exposed id stable across re-renders of the same instance', async () => {
    const wrapper = mount(WCardHeader, {
      slots: { default: 'Site info' }
    })

    const first = wrapper.vm.headingId
    await wrapper.setProps({})
    await wrapper.vm.$forceUpdate()
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.headingId).toBe(first)
  })

  it('does not put the id on the hint, only on the default-slot heading', () => {
    const wrapper = mount(WCardHeader, {
      slots: { default: 'Site info', hint: 'Shown in the browser tab' }
    })

    const heading = wrapper.find(`#${wrapper.vm.headingId}`)
    expect(heading.text()).toBe('Site info')
    expect(heading.text()).not.toContain('Shown in the browser tab')
  })
})

/**
 * OpenProject #1630 (task 1633): `WCardHeader` used to render a plain `<div>`, so every card and
 * dialog section it headed contributed nothing to the page's heading structure. `level` (defaulting
 * to `h2`, since a card/dialog section sits one level under the page's own `h1`) is purely semantic
 * -- the visual is entirely the two classes below, unaffected by which tag renders them.
 */
describe('WCardHeader', () => {
  it('defaults to rendering an <h2>, carrying its visual classes', () => {
    const wrapper = mount(WCardHeader, { slots: { default: 'Site info' } })

    const heading = wrapper.find('h2')
    expect(heading.exists()).toBe(true)
    expect(heading.classes()).toEqual(expect.arrayContaining(['w-card-header', 'w-section-header']))
    expect(heading.text()).toContain('Site info')
  })

  it.each(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])(
    'renders a <%s> when level is set to it',
    (level) => {
      const wrapper = mount(WCardHeader, {
        props: { level },
        slots: { default: 'Section' }
      })

      expect(wrapper.element.tagName.toLowerCase()).toBe(level)
      // -> Only one heading element in the tree either way, at the level asked for
      expect(wrapper.findAll('h1,h2,h3,h4,h5,h6')).toHaveLength(1)
    }
  )

  it('still renders the hint and action slots regardless of level', () => {
    const wrapper = mount(WCardHeader, {
      props: { level: 'h3' },
      slots: {
        default: 'Title',
        hint: 'A hint',
        action: '<button>Reset</button>'
      }
    })

    expect(wrapper.find('.w-card-header__hint').text()).toBe('A hint')
    expect(wrapper.find('.w-card-header__action').text()).toBe('Reset')
  })
})
