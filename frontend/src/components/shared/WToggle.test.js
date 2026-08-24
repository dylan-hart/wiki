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

  it.each([
    { dense: false, modelValue: false, expected: 'translate-x-0.5' },
    { dense: false, modelValue: true, expected: 'translate-x-6.5' },
    { dense: true, modelValue: false, expected: 'translate-x-0.5' },
    { dense: true, modelValue: true, expected: 'translate-x-5.5' }
  ])(
    'offsets the knob by $expected when dense=$dense modelValue=$modelValue',
    ({ dense, modelValue, expected }) => {
      const wrapper = mount(WToggle, { props: { modelValue, ariaLabel: 'Feature', dense } })

      expect(wrapper.find('.w-toggle__knob').classes()).toContain(expected)
    }
  )

  it('does not centre the knob rest position on the track', () => {
    const wrapper = mount(WToggle, { props: { modelValue: false, ariaLabel: 'Feature' } })

    expect(wrapper.find('.w-toggle__track').classes()).not.toContain('justify-center')
  })
})
