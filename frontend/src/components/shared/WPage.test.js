import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WPage from './WPage.vue'

describe('WPage skip-link target', () => {
  it('renders its <main> with the id and tabindex the skip link needs', () => {
    const wrapper = mount(WPage, { slots: { default: 'Page content' } })

    const main = wrapper.find('main')
    expect(main.attributes('id')).toBe('w-page-main')
    expect(main.attributes('tabindex')).toBe('-1')
  })
})
