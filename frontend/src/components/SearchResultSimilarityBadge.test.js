import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import SearchResultSimilarityBadge from './SearchResultSimilarityBadge.vue'

import { createTestI18n } from '../../test/i18n.js'

const MESSAGES = {
  search: {
    similarityMatch: '{percent}% match'
  }
}

function mountBadge(props) {
  return mount(SearchResultSimilarityBadge, {
    props,
    global: { plugins: [createTestI18n(MESSAGES)] }
  })
}

/**
 * OpenProject #3223: the semantic-mode similarity match badge. `distance` (cosine distance, smaller
 * = closer) is the only input, converted client-side to a percentage-style "N% match" label per the
 * work package's resolved scope.
 */
describe('SearchResultSimilarityBadge', () => {
  it('draws the badge with a rounded percentage label for a typical distance', () => {
    const wrapper = mountBadge({ distance: 0.13 })

    expect(wrapper.find('.search-result-similarity-badge').exists()).toBe(true)
    expect(wrapper.text()).toBe('87% match')
  })

  it('draws a 100% match for a distance of exactly 0', () => {
    const wrapper = mountBadge({ distance: 0 })

    expect(wrapper.text()).toBe('100% match')
  })

  it('draws a 0% match for a distance of exactly 1', () => {
    const wrapper = mountBadge({ distance: 1 })

    expect(wrapper.text()).toBe('0% match')
  })

  it('clamps a negative distance to a 100% match rather than exceeding 100', () => {
    const wrapper = mountBadge({ distance: -0.2 })

    expect(wrapper.text()).toBe('100% match')
  })

  it('clamps a distance greater than 1 to a 0% match rather than going negative', () => {
    const wrapper = mountBadge({ distance: 1.4 })

    expect(wrapper.text()).toBe('0% match')
  })

  it('rounds to the nearest whole percent', () => {
    const wrapper = mountBadge({ distance: 0.264 })

    // -> (1 - 0.264) * 100 = 73.6 -> rounds up to 74
    expect(wrapper.text()).toBe('74% match')
  })

  it('draws nothing when distance is absent, as on every keyword-mode result', () => {
    const wrapper = mountBadge({})

    expect(wrapper.find('.search-result-similarity-badge').exists()).toBe(false)
    expect(wrapper.text()).toBe('')
  })

  it('draws nothing when distance is explicitly null', () => {
    const wrapper = mountBadge({ distance: null })

    expect(wrapper.find('.search-result-similarity-badge').exists()).toBe(false)
  })

  it('draws nothing when distance is NaN', () => {
    const wrapper = mountBadge({ distance: Number.NaN })

    expect(wrapper.find('.search-result-similarity-badge').exists()).toBe(false)
  })

  it('carries a visible text label rather than relying on color or an icon alone (WCAG 1.4.1)', () => {
    const wrapper = mountBadge({ distance: 0.13 })

    expect(wrapper.text().trim().length).toBeGreaterThan(0)
  })

  /*
    OpenProject #3293: it used to render as a `w-chip` with an icon and a hairline-pill border, sized
    for sitting on the title line. Now it lives in the meta column as plain text, styled by that
    column's own CSS rather than carrying any of its own.
  */
  it('renders as plain text, not a w-chip with an icon', () => {
    const wrapper = mountBadge({ distance: 0.13 })

    expect(wrapper.element.tagName).toBe('SPAN')
    expect(wrapper.find('.w-chip').exists()).toBe(false)
    expect(wrapper.find('iconify-icon').exists()).toBe(false)
  })
})
