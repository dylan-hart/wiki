import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import BlueprintIcon from './BlueprintIcon.vue'

/**
 * `indicatorDot` decides whether the little status badge (used across the admin area for "requires
 * Sharp" warnings) renders at all. Callers that only ever wrote `indicator` as a bare attribute — no
 * `:indicator="..."` binding — passed the empty string on every render regardless of the condition
 * they meant to express, which `indicatorDot` treats as truthy (`'' === '' ? 'pink' : ...`) same as
 * any other non-null value. This locks down the contract a caller must actually use: `null` hides
 * the badge, anything else (including `''`) shows it.
 */
describe('BlueprintIcon indicator', () => {
  it('renders no badge when indicator is not passed (defaults to null)', () => {
    const wrapper = mount(BlueprintIcon, { props: { icon: 'home' } })
    expect(wrapper.find('.w-badge').exists()).toBe(false)
  })

  it('renders no badge when indicator is explicitly null', () => {
    const wrapper = mount(BlueprintIcon, { props: { icon: 'home', indicator: null } })
    expect(wrapper.find('.w-badge').exists()).toBe(false)
  })

  it('renders a badge when indicator is an empty string', () => {
    const wrapper = mount(BlueprintIcon, { props: { icon: 'home', indicator: '' } })
    expect(wrapper.find('.w-badge').exists()).toBe(true)
  })

  it('renders a badge when indicator names a color', () => {
    const wrapper = mount(BlueprintIcon, { props: { icon: 'home', indicator: 'red' } })
    expect(wrapper.find('.w-badge').exists()).toBe(true)
  })
})
