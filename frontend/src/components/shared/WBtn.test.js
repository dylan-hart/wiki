import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WBtn from './WBtn.vue'

describe('WBtn', () => {
  it('renders a native button by default, and emits click', async () => {
    const wrapper = mount(WBtn, { props: { label: 'Save' } })

    expect(wrapper.element.tagName).toBe('BUTTON')
    expect(wrapper.text()).toBe('Save')

    await wrapper.trigger('click')

    expect(wrapper.emitted('click')).toHaveLength(1)
  })

  it('renders an anchor when href is set, carrying target and rel', () => {
    const wrapper = mount(WBtn, {
      props: { label: 'Docs', href: 'https://example.com', target: '_blank' }
    })

    expect(wrapper.element.tagName).toBe('A')
    expect(wrapper.attributes('href')).toBe('https://example.com')
    expect(wrapper.attributes('target')).toBe('_blank')
    expect(wrapper.attributes('rel')).toBe('noopener noreferrer')
  })

  it('blocks the click when disabled, without emitting', async () => {
    const wrapper = mount(WBtn, { props: { label: 'Save', disabled: true } })

    await wrapper.trigger('click')

    expect(wrapper.emitted('click')).toBeUndefined()
  })

  it('blocks the click while loading, and shows the spinner instead of the label', async () => {
    const wrapper = mount(WBtn, { props: { label: 'Save', loading: true } })

    expect(wrapper.find('.w-spinner').exists()).toBe(true)
    expect(wrapper.attributes('aria-busy')).toBe('true')

    await wrapper.trigger('click')

    expect(wrapper.emitted('click')).toBeUndefined()
  })

  it('renders no nameless button for an icon-only instance with an explicit aria-label', () => {
    // WBtn itself derives no accessible name from `icon` -- an icon-only caller must supply one,
    // either an `aria-label` (as here) or a `<w-tooltip labels>` naming it from the slot.
    const wrapper = mount(WBtn, {
      props: { icon: 'mdi:cog' },
      attrs: { 'aria-label': 'Settings' }
    })

    expect(wrapper.text()).toBe('')
    expect(wrapper.attributes('aria-label')).toBe('Settings')
  })
})
