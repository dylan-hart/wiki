import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import SearchResultHopBadge from './SearchResultHopBadge.vue'

import { createTestI18n } from '../../test/i18n.js'

const MESSAGES = {
  search: {
    relatedResult: 'Related',
    relatedResultHint: 'This result did not match your search directly.'
  }
}

function mountBadge(props) {
  return mount(SearchResultHopBadge, {
    props,
    global: { plugins: [createTestI18n(MESSAGES)] }
  })
}

describe('SearchResultHopBadge', () => {
  it('draws the badge, with its visible label, for a hop-2 result', () => {
    const wrapper = mountBadge({ hop: 2 })

    expect(wrapper.find('.search-result-hop-badge').exists()).toBe(true)
    expect(wrapper.text()).toBe('Related')
  })

  it('draws nothing for a hop-1 (direct match) result', () => {
    const wrapper = mountBadge({ hop: 1 })

    expect(wrapper.find('.search-result-hop-badge').exists()).toBe(false)
    expect(wrapper.text()).toBe('')
  })

  it('draws nothing when hop is absent, as on every keyword-mode result', () => {
    const wrapper = mountBadge({})

    expect(wrapper.find('.search-result-hop-badge').exists()).toBe(false)
  })

  it('draws nothing for a hop value other than 1 or 2', () => {
    const wrapper = mountBadge({ hop: 3 })

    expect(wrapper.find('.search-result-hop-badge').exists()).toBe(false)
  })

  it('carries a visible text label rather than relying on color or an icon alone (WCAG 1.4.1)', () => {
    const wrapper = mountBadge({ hop: 2 })

    // -> The chip's accessible name comes from this text alone: the icon beside it renders
    //    `aria-hidden="true"`, so it contributes nothing.
    expect(wrapper.text().trim().length).toBeGreaterThan(0)
  })
})
