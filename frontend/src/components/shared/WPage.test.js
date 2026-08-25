import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WPage from './WPage.vue'

/**
 * OpenProject #1644: `MainLayout`'s skip link targets `#main-content` and moves focus into it on
 * activation. `<main>` is a landmark, not natively focusable, so `tabindex="-1"` is what lets an
 * `href="#main-content"` activation actually land focus here rather than silently scrolling to it
 * with nothing focused.
 */
describe('WPage', () => {
  it('renders the main-content id and tabindex="-1" that the skip link targets', () => {
    const wrapper = mount(WPage, { slots: { default: 'content' } })

    const main = wrapper.find('main')
    expect(main.attributes('id')).toBe('main-content')
    expect(main.attributes('tabindex')).toBe('-1')
  })
})
