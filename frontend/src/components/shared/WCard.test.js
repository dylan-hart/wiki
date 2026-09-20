import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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

  it('draws its corner and elevation off --radius-card / --shadow-card', () => {
    const wrapper = mount(WCard)

    expect(wrapper.classes()).toContain('rounded-card')
    expect(wrapper.classes()).toContain('shadow-card')
  })

  /*
   * The test environment has no CSS cascade to resolve `var()` against, so the token can only be
   * checked against the component's own source text.
   */
  it('draws its edge off --border-card rather than a hardcoded hairline utility pair', () => {
    const wrapper = mount(WCard)

    expect(wrapper.classes()).not.toContain('border')
    expect(wrapper.classes()).not.toContain('border-hairline')
    expect(wrapper.classes()).not.toContain('dark:border-hairline-dark')

    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'WCard.vue'), 'utf-8')
    expect(source).toMatch(/border:\s*var\(--border-card\)/)
  })
})
