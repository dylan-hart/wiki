import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import PageHeader from './PageHeader.vue'
import { usePageStore } from '@/stores/page'
import { useDirection } from '@/composables/direction'
import WMenu from '@/components/shared/WMenu.vue'

/**
 * Regression test for OpenProject #2000: `notImplemented()` showed a red toast with the untranslated
 * literal 'Not implemented' and was never called from anywhere in this component -- dead code left
 * over from an earlier stub. Reads the raw source rather than mounting, matching
 * `EditorMarkdown.deadcode.test.js`'s reasoning: this asserts an identifier is simply gone, and also
 * guards against it quietly being reintroduced.
 */
describe('PageHeader dead code', () => {
  it('has no notImplemented() helper', () => {
    const source = readFileSync(join(import.meta.dirname, 'PageHeader.vue'), 'utf-8')

    expect(source).not.toMatch(/notImplemented/)
  })
})

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

/**
 * OpenProject #1630/#1633: the title of every wiki page used to render into a plain
 * `<div class="text-h4 page-header-title">` -- a heading NEITHER role nor level, so a screen
 * reader's heading navigation (the H key / rotor) found nothing to land a reader on here. Fixed by
 * changing the element only; the classes (and therefore the visuals) are unchanged. See the
 * accessibility audit's heading-hierarchy pass (`docs/audit-2026-08-24/accessibility-i18n.md` §3).
 */
describe('PageHeader heading semantics', () => {
  it('renders the page title as a real <h1>, carrying the same classes as before', async () => {
    const wrapper = await mountHeader()

    const heading = wrapper.find('h1.page-header-title')
    expect(heading.exists()).toBe(true)
    expect(heading.classes()).toContain('text-h4')
    // -> No stray `<div class="text-h4 page-header-title">` left behind alongside it
    expect(wrapper.find('div.page-header-title').exists()).toBe(false)
  })

  it('renders the resolved title text inside the <h1>', async () => {
    const wrapper = await mountHeader()
    usePageStore().$patch({ title: 'Getting Started' })
    await wrapper.vm.$nextTick()

    const titleEl = wrapper.find('h1.page-header-title')
    expect(titleEl.text()).toBe('Getting Started')
  })
})

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

/**
 * Regression coverage for feature 413 ("RTL support end-to-end"), task 721: the review-queue
 * dropdown's `anchor`/`self` used to be hardcoded `"bottom right"`/`"top right"`, which pops the
 * panel toward the visual right regardless of direction. Unlike `EditorMarkdown.vue`'s side toolbar
 * (mounted only for one editing session, so a read-once `document.documentElement.dir` at setup is
 * an accepted tradeoff there), `PageHeader` stays mounted across navigations -- a reader moving from
 * an LTR page to an RTL one in the same visit must see this flip too, so it is read reactively off
 * `composables/direction.js` rather than once at setup.
 */
describe('PageHeader review-queue menu direction', () => {
  afterEach(() => {
    // -> `useDirection`'s backing ref is module-level state shared with every other test file that
    //    imports it in this run; leaving it flipped would bleed into whichever test happens to run next
    useDirection().set(false)
  })

  async function mountHeaderWithReviewQueue() {
    const wrapper = await mountHeader()
    usePageStore().$patch({ canReview: true, editor: null })
    await wrapper.vm.$nextTick()
    return wrapper
  }

  it('anchors the review-queue menu to the trailing (right) edge under ltr', async () => {
    const wrapper = await mountHeaderWithReviewQueue()

    const menu = wrapper.findAllComponents(WMenu).at(-1)
    expect(menu.props('anchor')).toBe('bottom right')
    expect(menu.props('self')).toBe('top right')
  })

  it('mirrors the review-queue menu to the trailing (left) edge under rtl', async () => {
    useDirection().set(true)
    const wrapper = await mountHeaderWithReviewQueue()

    const menu = wrapper.findAllComponents(WMenu).at(-1)
    expect(menu.props('anchor')).toBe('bottom left')
    expect(menu.props('self')).toBe('top left')
  })

  it('re-mirrors reactively when direction flips after mount, since this header outlives a locale', async () => {
    const wrapper = await mountHeaderWithReviewQueue()
    const menuBefore = wrapper.findAllComponents(WMenu).at(-1)
    expect(menuBefore.props('anchor')).toBe('bottom right')

    useDirection().set(true)
    await wrapper.vm.$nextTick()

    const menuAfter = wrapper.findAllComponents(WMenu).at(-1)
    expect(menuAfter.props('anchor')).toBe('bottom left')
  })
})
