import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WCard from './WCard.vue'

describe('WCard', () => {
  it('renders its slot content', () => {
    const wrapper = mount(WCard, { slots: { default: '<p>Hello</p>' } })

    expect(wrapper.find('p').text()).toBe('Hello')
  })

  it('lays sections out in a row when horizontal is set', () => {
    const wrapper = mount(WCard, { props: { horizontal: true } })

    expect(wrapper.classes()).toContain('flex')
    expect(wrapper.classes()).toContain('flex-nowrap')
  })

  /*
   * `--radius-card` / `--shadow-card` are `0` / `none` under Ledger (unchanged from before this
   * task) and real values under Cobalt (`body.body--cobalt`, OpenProject #2767/#2772) -- one pair
   * of classes, no aesthetic branch. The hairline border stays a plain `border-hairline` pair
   * rather than the new `--border-card` token, which has no dark-mode-specific value yet (see
   * WCard.vue's own comment) -- flagged for follow-up, not fixed here.
   */
  it('draws its corner and elevation off --radius-card / --shadow-card', () => {
    const wrapper = mount(WCard)

    expect(wrapper.classes()).toContain('rounded-card')
    expect(wrapper.classes()).toContain('shadow-card')
  })

  it('still carries its hairline border classes', () => {
    const wrapper = mount(WCard)

    expect(wrapper.classes()).toContain('border-hairline')
    expect(wrapper.classes()).toContain('dark:border-hairline-dark')
  })
})
