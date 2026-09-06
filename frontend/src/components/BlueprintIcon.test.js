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

/**
 * `standalone` drops the `WItemSection` wrapper, which is a `WItem`-ism: it is what gives a list
 * row's leading column its 56px width and 16px trailing gutter. `WSettingsRow` lays out its own
 * 14px gap and would otherwise get 33px.
 */
describe('BlueprintIcon standalone', () => {
  it('wraps the plate in an item section by default', () => {
    const wrapper = mount(BlueprintIcon, { props: { icon: 'tabler:home' } })

    expect(wrapper.classes()).toContain('w-item-section')
    expect(wrapper.classes()).toContain('w-item-section--avatar')
    expect(wrapper.find('.blueprint-icon').exists()).toBe(true)
  })

  it('makes the plate itself the root when standalone', () => {
    const wrapper = mount(BlueprintIcon, { props: { icon: 'tabler:home', standalone: true } })

    expect(wrapper.classes()).toContain('blueprint-icon')
    expect(wrapper.find('.w-item-section').exists()).toBe(false)
  })

  it('keeps a class the caller passes on the root either way', () => {
    const wrapped = mount(BlueprintIcon, {
      props: { icon: 'tabler:home' },
      attrs: { class: 'self-start' }
    })
    expect(wrapped.classes()).toContain('self-start')

    const bare = mount(BlueprintIcon, {
      props: { icon: 'tabler:home', standalone: true },
      attrs: { class: 'self-start' }
    })
    expect(bare.classes()).toContain('self-start')
  })

  it('still draws the indicator badge and a code plate when standalone', () => {
    const wrapper = mount(BlueprintIcon, {
      props: { text: 'EN', standalone: true, indicator: '', indicatorText: 'Requires Sharp' }
    })

    expect(wrapper.find('.w-badge').exists()).toBe(true)
    expect(wrapper.find('.blueprint-icon__text').text()).toBe('EN')
  })
})
