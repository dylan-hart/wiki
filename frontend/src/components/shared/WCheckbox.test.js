import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WCheckbox from './WCheckbox.vue'

describe('WCheckbox', () => {
  it('reflects a boolean model as aria-checked and shows the check icon when on', () => {
    const wrapper = mount(WCheckbox, { props: { modelValue: true, ariaLabel: 'Enabled' } })

    expect(wrapper.attributes('aria-checked')).toBe('true')
    expect(wrapper.find('.w-checkbox__box--on').exists()).toBe(true)
    // -> The check glyph itself, resolved through `w-icon` registered globally in test/setup.js
    expect(wrapper.find('[data-icon="tabler:check"]').exists()).toBe(true)
  })

  it('emits the flipped boolean on click when bound to a boolean model', async () => {
    const wrapper = mount(WCheckbox, { props: { modelValue: false, ariaLabel: 'Enabled' } })

    await wrapper.trigger('click')

    expect(wrapper.emitted('update:modelValue')).toEqual([[true]])
  })

  it('adds val to an array model on click, and removes it on the next', async () => {
    const wrapper = mount(WCheckbox, {
      props: { modelValue: ['a'], val: 'b', ariaLabel: 'b' }
    })

    await wrapper.trigger('click')
    expect(wrapper.emitted('update:modelValue')[0]).toEqual([['a', 'b']])

    await wrapper.setProps({ modelValue: ['a', 'b'] })
    await wrapper.trigger('click')
    expect(wrapper.emitted('update:modelValue')[1]).toEqual([['a']])
  })

  it('renders the mixed dash glyph, not the check glyph, when indeterminate', () => {
    const wrapper = mount(WCheckbox, {
      props: { modelValue: false, ariaLabel: 'Group', indeterminate: true }
    })

    expect(wrapper.attributes('aria-checked')).toBe('mixed')
    expect(wrapper.find('.w-checkbox__box--on').exists()).toBe(true)
    expect(wrapper.find('[data-icon="tabler:minus"]').exists()).toBe(true)
    expect(wrapper.find('[data-icon="tabler:check"]').exists()).toBe(false)
  })

  it('reports the click as a plain boolean flip while indeterminate, leaving the parent to decide', async () => {
    const wrapper = mount(WCheckbox, {
      props: { modelValue: false, ariaLabel: 'Group', indeterminate: true }
    })

    await wrapper.trigger('click')

    expect(wrapper.emitted('update:modelValue')).toEqual([[true]])
  })

  it('marks the button element disabled via the disabled prop', () => {
    const wrapper = mount(WCheckbox, {
      props: { modelValue: false, ariaLabel: 'Enabled', disabled: true }
    })

    expect(wrapper.attributes('disabled')).toBeDefined()
    expect(wrapper.classes()).toContain('opacity-60')
  })

  it.each([
    { dense: false, expected: 'size-[13px]' },
    { dense: true, expected: 'size-3' }
  ])('sizes the box $expected when dense is $dense', ({ dense, expected }) => {
    const wrapper = mount(WCheckbox, {
      props: { modelValue: false, ariaLabel: 'Enabled', dense }
    })

    expect(wrapper.find('.w-checkbox__box').classes()).toContain(expected)
  })

  it('shrinks the check glyph to match the dense box', () => {
    const wrapper = mount(WCheckbox, {
      props: { modelValue: true, ariaLabel: 'Enabled', dense: true }
    })

    expect(wrapper.find('[data-icon="tabler:check"]').attributes('style')).toContain('0.75em')
  })
})
