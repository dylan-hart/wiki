import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WToggle from './WToggle.vue'

describe('WToggle', () => {
  it('renders off by default, and toggles on click', async () => {
    const wrapper = mount(WToggle, { props: { modelValue: false, ariaLabel: 'Feature' } })

    expect(wrapper.attributes('aria-checked')).toBe('false')

    await wrapper.trigger('click')

    expect(wrapper.emitted('update:modelValue')).toEqual([[true]])
  })

  it('draws the track and knob off --radius-pill, not a hardcoded square', () => {
    // -> The token resolves to 0 under one aesthetic and a real radius under another, so the class
    //    is what can be asserted here, not a computed radius.
    const wrapper = mount(WToggle, { props: { modelValue: true, ariaLabel: 'Feature' } })

    expect(wrapper.find('.w-toggle__track').classes()).toContain('rounded-pill')
    expect(wrapper.find('.w-toggle__knob').classes()).toContain('rounded-pill')
  })

  it('reflects an already-true modelValue immediately, with no separate mount transition', () => {
    const wrapper = mount(WToggle, { props: { modelValue: true, ariaLabel: 'Feature' } })

    expect(wrapper.attributes('aria-checked')).toBe('true')
  })

  it('blocks the click while disabled', async () => {
    const wrapper = mount(WToggle, {
      props: { modelValue: false, ariaLabel: 'Feature', disabled: true }
    })

    await wrapper.trigger('click')

    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('shows a spinner instead of the knob while loading, and blocks the click', async () => {
    const wrapper = mount(WToggle, {
      props: { modelValue: false, ariaLabel: 'Feature', loading: true }
    })

    expect(wrapper.find('.w-spinner').exists()).toBe(true)
    expect(wrapper.find('.w-toggle__knob').exists()).toBe(false)
    expect(wrapper.attributes('aria-busy')).toBe('true')

    await wrapper.trigger('click')

    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('renders the knob, not a spinner, once loading clears', () => {
    const wrapper = mount(WToggle, {
      props: { modelValue: true, ariaLabel: 'Feature', loading: false }
    })

    expect(wrapper.find('.w-spinner').exists()).toBe(false)
    expect(wrapper.find('.w-toggle__knob').exists()).toBe(true)
  })

  /*
    The knob sits at one END of the track via flexbox rather than being translated across, which is
    what makes the two ends hold whatever the track's width and the knob's size are -- hence all
    four combinations here.
  */
  it.each([
    { dense: false, modelValue: false, expected: 'justify-start' },
    { dense: false, modelValue: true, expected: 'justify-end' },
    { dense: true, modelValue: false, expected: 'justify-start' },
    { dense: true, modelValue: true, expected: 'justify-end' }
  ])(
    'sits the knob at $expected when dense=$dense modelValue=$modelValue',
    ({ dense, modelValue, expected }) => {
      const wrapper = mount(WToggle, { props: { modelValue, ariaLabel: 'Feature', dense } })

      expect(wrapper.find('.w-toggle__track').classes()).toContain(expected)
    }
  )

  it.each([
    { dense: false, expected: 'size-3.5' },
    { dense: true, expected: 'size-3' }
  ])('sizes the knob $expected when dense=$dense', ({ dense, expected }) => {
    const wrapper = mount(WToggle, { props: { modelValue: true, ariaLabel: 'Feature', dense } })

    expect(wrapper.find('.w-toggle__knob').classes()).toContain(expected)
  })

  it('fills the track in the accent when on, and leaves it a hairline box when off', () => {
    const on = mount(WToggle, { props: { modelValue: true, ariaLabel: 'Feature' } })
    const off = mount(WToggle, { props: { modelValue: false, ariaLabel: 'Feature' } })

    expect(on.find('.w-toggle__track').classes()).toContain('w-toggle__track--on')
    expect(off.find('.w-toggle__track').classes()).not.toContain('w-toggle__track--on')
    expect(off.find('.w-toggle__track').classes()).toContain('border-slate-pale')
  })

  it('does not centre the knob rest position on the track', () => {
    const wrapper = mount(WToggle, { props: { modelValue: false, ariaLabel: 'Feature' } })

    expect(wrapper.find('.w-toggle__track').classes()).not.toContain('justify-center')
  })
})
