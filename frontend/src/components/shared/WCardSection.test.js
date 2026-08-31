import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WCardSection from './WCardSection.vue'

describe('WCardSection', () => {
  it('renders slot content, padded by default', () => {
    const wrapper = mount(WCardSection, { slots: { default: 'Hello' } })

    expect(wrapper.text()).toBe('Hello')
    expect(wrapper.classes()).toContain('p-4')
  })

  it('drops its own padding and lays out horizontally when horizontal', () => {
    const wrapper = mount(WCardSection, { props: { horizontal: true } })

    expect(wrapper.classes()).not.toContain('p-4')
    expect(wrapper.classes()).toEqual(expect.arrayContaining(['flex', 'items-center']))
  })

  // -> OpenProject #1805: id is a declared prop (not left to $attrs fallthrough), e.g.
  //    PagePropertiesDialog.vue's sections, each scrolled into view by id from its own sidebar nav
  //    (`document.querySelector('#' + id).scrollIntoView(...)`).
  it('renders a native id for a caller to scroll a specific section into view by', () => {
    const wrapper = mount(WCardSection, { props: { id: 'refCardInfo' } })

    expect(wrapper.attributes('id')).toBe('refCardInfo')
  })

  it('renders no id attribute when none is given', () => {
    const wrapper = mount(WCardSection)

    expect(wrapper.attributes('id')).toBeUndefined()
  })
})
