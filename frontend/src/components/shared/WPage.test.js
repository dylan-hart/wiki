import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WPage from './WPage.vue'

/**
 * OpenProject #1630 (task 1644): `id="w-page-main"` plus `tabindex="-1"` are what
 * `MainLayout`'s skip link targets -- a `<main>` is not naturally focusable, and a plain fragment
 * link only moves the reader's scroll position without a focusable target at the far end of it.
 */
describe('WPage skip-link target', () => {
  it('renders its <main> with the id and tabindex the skip link needs', () => {
    const wrapper = mount(WPage, { slots: { default: 'Page content' } })

    const main = wrapper.find('main')
    expect(main.attributes('id')).toBe('w-page-main')
    expect(main.attributes('tabindex')).toBe('-1')
  })
})
