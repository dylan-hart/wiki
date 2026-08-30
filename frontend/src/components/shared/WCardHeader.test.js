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
