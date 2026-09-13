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

/**
 * OpenProject #3106: the hop-2 "related via" indicator. `hop` is the only input -- the badge draws
 * for the literal number `2` and draws nothing for every other value a result row can carry,
 * `hop: 1` (a direct match, keyword or semantic) and no `hop` field at all (every keyword-mode
 * result) included.
 */
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

    // -> The chip's accessible name to assistive tech comes from this text -- the icon beside it
    //    renders `aria-hidden="true"` (see WIcon), so it contributes nothing to the accessible name.
    expect(wrapper.text().trim().length).toBeGreaterThan(0)
  })
})
