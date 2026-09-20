import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WBreadcrumbs from './WBreadcrumbs.vue'

/**
 * Under `dir="rtl"` a flex row already reorders the icon and its label, so a margin glued to the
 * physical `mr-` side lands between the icon and the crumb it follows rather than between the icon
 * and its own label. `me-2` (margin-inline-end) always lands on the icon's trailing side.
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
