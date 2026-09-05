import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WBreadcrumbs from './WBreadcrumbs.vue'

/**
 * Regression coverage for feature 413 ("RTL support end-to-end"), task 721: the gap between a
 * crumb's icon and its label used `mr-2`, a PHYSICAL Tailwind utility that stays on the visual right
 * whatever the reader's text direction is. Under `dir="rtl"` a flex row already reorders the icon and
 * the label -- but a margin still glued to `mr-` would then land on the wrong side of the icon,
 * pinching the two together instead of the icon and the crumb it follows. `me-2` (margin-inline-end)
 * is the fix: it always lands on the icon's TRAILING side, in either direction.
 */
describe('WBreadcrumbs', () => {
  it('spaces an icon from its label with a logical (inline-end) margin, not a physical one', () => {
    const wrapper = mount(WBreadcrumbs, {
      props: {
        items: [{ icon: 'tabler:home', label: 'Home', to: '/' }, { label: 'Docs' }]
      }
    })

    const icon = wrapper.find('.w-breadcrumbs__el-icon')
    expect(icon.classes()).toContain('me-2')
    expect(icon.classes()).not.toContain('mr-2')
  })

  it('adds no spacing class to an icon-only crumb, which has no label to space it from', () => {
    const wrapper = mount(WBreadcrumbs, {
      props: {
        items: [{ icon: 'tabler:home', to: '/' }, { label: 'Docs' }]
      }
    })

    const icon = wrapper.find('.w-breadcrumbs__el-icon')
    expect(icon.classes()).not.toContain('me-2')
    expect(icon.classes()).not.toContain('mr-2')
  })
})
