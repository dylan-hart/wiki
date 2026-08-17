import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import Index from './Index.vue'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'

/**
 * Regression coverage for task 633's wiring: `PageComments.vue` is mounted inside the article
 * column, gated on `siteStore.features.comments && pageStore.allowComments` -- the same
 * boolean-AND pattern the adjacent ratings block already uses. Everything else `Index.vue` renders
 * is stubbed out: this view pulls in the editor, header, TOC and actions column, none of which this
 * task touches, and giving each its own store/route/permission setup here would test THEIR
 * behaviour, not the gate this task added.
 */

/*
 * `useMinWidth` (via `useScreen`) calls `window.matchMedia`, and the common store's `state()`
 * reads `localStorage.getItem('locale')` the moment it's instantiated. Neither has been needed by
 * any existing test -- mounting a full page view, which pulls in `useCommonStore`, is new here --
 * so both are stubbed locally rather than added to the shared `test/setup.js`, which would be a
 * bigger claim about every future test's needs than this one warrants. `localStorage` in particular
 * is a real (but non-functional, `--localstorage-file`-less) Node global in this runtime rather than
 * simply absent, so it has to be overwritten, not merely filled in when missing.
 */
beforeEach(() => {
  window.matchMedia =
    window.matchMedia ??
    vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))

  const store = new Map()
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear()
  }
})

/*
 * Torn down after every test, not left for the next mount to overwrite: `setActivePinia` in the
 * next test replaces the active pinia instance while this one's stores are still live, and an
 * un-unmounted component keeps its watchers/computeds running against them -- which then observe a
 * disposed reactive scope (`pagePermissions.includes` on a revoked proxy) as an unhandled rejection
 * on the next microtask, unrelated to whatever that next test is actually asserting.
 */
let activeWrapper = null

afterEach(() => {
  activeWrapper?.unmount()
  activeWrapper = null
})

async function mountIndex() {
  setActivePinia(createPinia())

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }]
  })
  router.push('/')
  await router.isReady()

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  const wrapper = mount(Index, {
    global: {
      plugins: [router, i18n],
      stubs: {
        PageHeader: true,
        PageActionsCol: true,
        PageToc: true,
        PageTags: true,
        SideDialog: true,
        PageRedirect: true,
        FooterNav: true,
        PageComments: true
      }
    }
  })
  activeWrapper = wrapper

  return { wrapper, pageStore: usePageStore(), siteStore: useSiteStore() }
}

describe('Index.vue: page-view comments gating', () => {
  it('does not render page-comments when the site feature is off, even if the page allows it', async () => {
    const { wrapper, pageStore, siteStore } = await mountIndex()
    siteStore.features.comments = false
    pageStore.allowComments = true
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent({ name: 'PageComments' }).exists()).toBe(false)
  })

  it('does not render page-comments when the page disallows it, even if the site feature is on', async () => {
    const { wrapper, pageStore, siteStore } = await mountIndex()
    siteStore.features.comments = true
    pageStore.allowComments = false
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent({ name: 'PageComments' }).exists()).toBe(false)
  })

  it('renders page-comments once both the site feature and the page allow it, reactively', async () => {
    const { wrapper, pageStore, siteStore } = await mountIndex()
    expect(wrapper.findComponent({ name: 'PageComments' }).exists()).toBe(false)

    siteStore.features.comments = true
    pageStore.allowComments = true
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent({ name: 'PageComments' }).exists()).toBe(true)
  })
})
