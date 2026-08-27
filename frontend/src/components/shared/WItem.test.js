import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WItem from './WItem.vue'

describe('WItem', () => {
  it('is interactive when clickable: a tab stop, role="button", and emits click', async () => {
    const wrapper = mount(WItem, { props: { clickable: true } })

    expect(wrapper.attributes('tabindex')).toBe('0')
    expect(wrapper.attributes('role')).toBe('button')
    expect(wrapper.attributes('aria-disabled')).toBeUndefined()

    await wrapper.trigger('click')

    expect(wrapper.emitted('click')).toHaveLength(1)
  })

  it('blocks the click when disabled, without emitting, and drops the tab stop/role', async () => {
    const wrapper = mount(WItem, { props: { clickable: true, disabled: true } })

    expect(wrapper.attributes('tabindex')).toBeUndefined()
    expect(wrapper.attributes('role')).toBeUndefined()
    expect(wrapper.attributes('aria-disabled')).toBe('true')

    await wrapper.trigger('click')

    expect(wrapper.emitted('click')).toBeUndefined()
  })
})
