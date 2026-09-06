import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

/**
 * OpenProject #2694. Handoff 2 draws exactly two plates: the 34px one every settings row and the
 * anchored create menu wear, and a 28px one for a menu opened at the pointer, which "should not be
 * taller than the tree it covers".
 *
 * `compact` is additive and OFF by default on purpose -- `WSettingsRow`, `AdminGeneral` and every
 * other call site depend on 34px staying what you get for asking for nothing, so a regression that
 * shrank the default would move the whole admin area at once.
 *
 * The two measurements are read out of the component's own stylesheet rather than off
 * `getComputedStyle`: jsdom runs no layout engine and resolves nothing from a scoped `<style>` block,
 * so a rendered-box assertion here would pass against any numbers at all.
 */
describe('BlueprintIcon plate size', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'BlueprintIcon.vue'),
    'utf-8'
  )

  it('takes the full-size plate by default, with no compact modifier on the element', () => {
    const wrapper = mount(BlueprintIcon, { props: { icon: 'tabler:markdown' } })
    expect(wrapper.find('.blueprint-icon').classes()).not.toContain('blueprint-icon--compact')
  })

  it('takes the compact modifier when asked for it', () => {
    const wrapper = mount(BlueprintIcon, { props: { icon: 'tabler:markdown', compact: true } })
    expect(wrapper.find('.blueprint-icon').classes()).toContain('blueprint-icon--compact')
  })

  it('declares 34px as the base plate and 28px as the compact one', () => {
    const base = source.match(/\.blueprint-icon \{([\s\S]*?)\}/)?.[1] ?? ''
    expect(base).toMatch(/width:\s*34px/)
    expect(base).toMatch(/height:\s*34px/)
    expect(base).toMatch(/font-size:\s*17px/)

    const compact = source.match(/\.blueprint-icon--compact \{([\s\S]*?)\}/)?.[1] ?? ''
    expect(compact).toMatch(/width:\s*28px/)
    expect(compact).toMatch(/height:\s*28px/)
    expect(compact).toMatch(/font-size:\s*15px/)
  })
})
