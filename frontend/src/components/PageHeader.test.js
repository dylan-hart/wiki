import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import PageHeader from './PageHeader.vue'

/**
 * Regression coverage for feature 413 ("RTL support end-to-end"), task 721: this row is a plain flex
 * row, so a reader's text direction already reorders the icon, the title column and the action
 * buttons for free -- what does NOT follow along on its own is the GAP between them, which used to be
 * written as physical Tailwind utilities (`pl-4`, `ml-4`, `ml-2`, `mr-2`). Under `dir="rtl"` those
 * stay glued to the visual left/right they name, landing on the wrong side of whichever element the
 * flex reorder just moved -- `ps-4`/`ms-4`/`ms-2`/`me-2` (logical: inline-start/inline-end) are the
 * fix, since they resolve against the reader's direction rather than the viewport.
 */
async function mountHeader() {
  setActivePinia(createPinia())

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }]
  })
  router.push('/')
  await router.isReady()

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  return mount(PageHeader, {
    global: {
      plugins: [router, i18n]
    }
  })
}

describe('PageHeader RTL-safe spacing', () => {
  it('spaces the page icon from the title with a logical (inline-start) padding, not a physical one', async () => {
    const wrapper = await mountHeader()

    const iconColumn = wrapper.find('.flex-none')
    expect(iconColumn.classes()).toContain('ps-4')
    expect(iconColumn.classes()).not.toContain('pl-4')
  })

  it('spaces the action buttons with logical (inline-start/inline-end) margins, not physical ones', async () => {
    const wrapper = await mountHeader()

    const html = wrapper.html()
    // -> None of the physical margin utilities this row used to carry survive in the render
    expect(html).not.toMatch(/\bml-4\b/)
    expect(html).not.toMatch(/\bml-2\b/)
    expect(html).not.toMatch(/\bmr-2\b/)
  })
})
