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

  /*
   * `--radius-card` / `--shadow-card` are `0` / `none` under Ledger (unchanged from before this
   * task) and real values under Cobalt (`body.body--cobalt`, OpenProject #2767/#2772) -- one pair
   * of classes, no aesthetic branch.
   */
  it('draws its corner and elevation off --radius-card / --shadow-card', () => {
    const wrapper = mount(WCard)

    expect(wrapper.classes()).toContain('rounded-card')
    expect(wrapper.classes()).toContain('shadow-card')
  })

  /*
   * OpenProject #2811: the hairline border used to be a plain Tailwind `border-hairline`/
   * `dark:border-hairline-dark` utility pair, because `--border-card` had no dark-mode-specific
   * value yet. Now that `tailwind.css`'s `body.body--dark` block gives it one, the border reads
   * through the token instead -- `jsdom` has no real CSS cascade to resolve `var()` against (see
   * `cobaltTokens.test.js`'s own rationale for asserting against source text instead), so this
   * checks the old ad hoc utility classes are gone and the component's own scoped style declares
   * the token, the same way `AccountMenu.test.js` asserts against a sibling component's source.
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
