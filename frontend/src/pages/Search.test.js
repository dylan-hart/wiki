import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import Search from './Search.vue'

/*
 * `useMinWidth` (via `useScreen`) calls `window.matchMedia` -- happy-dom supplies one, but this
 * mirrors `Index.test.js`'s own defensive stub rather than assuming so, since nothing else in this
 * file needs the real implementation.
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
})

let activeWrapper = null

afterEach(() => {
  activeWrapper?.unmount()
  activeWrapper = null
  vi.clearAllMocks()
})

async function mountSearch() {
  setActivePinia(createPinia())

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/_search', component: { template: '<div />' } }]
  })
  router.push('/_search')
  await router.isReady()

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  const wrapper = mount(Search, {
    global: {
      plugins: [router, i18n],
      stubs: {
        HeaderNav: true,
        FooterNav: true,
        MainOverlayDialog: true
      }
    }
  })
  activeWrapper = wrapper
  await flushPromises()

  return { wrapper }
}

function resultItem(locale, path, title) {
  return {
    locale,
    path,
    title,
    description: '',
    icon: '',
    highlight: '',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

/**
 * WP #1728: `state.results` is replaced wholesale on any filter change (the `deep: true` watcher on
 * `state.params`), but the `w-item` row for each result had no `:key` -- Vue fell back to patching
 * rows in place by index instead of keying them by identity, reusing a row's DOM element (and any
 * component-internal state it held: focus, scroll position, in-flight transitions) across two
 * completely unrelated results. This asserts a row's DOM element is actually replaced, not patched
 * in place, when the result set changes to a different page of results at the same array index.
 */
describe('Search.vue results list keying (WP #1728)', () => {
  it('replaces a row DOM element (does not reuse it) when the result set changes to unrelated results', async () => {
    const { wrapper } = await mountSearch()

    wrapper.vm.state.results = [
      resultItem('en', 'page-one', 'Page One'),
      resultItem('en', 'page-two', 'Page Two')
    ]
    await flushPromises()

    // -> Select the row by the actual link it renders (`localizedPagePath`, no locale prefix here
    //    since `siteStore.localeRouting.useLocales` defaults falsy) rather than a class guess: the
    //    results list is the only `w-item v-for` in the template keyed off `state.results`.
    const firstRowBefore = wrapper.find('a[href="/page-one"]')
    expect(firstRowBefore.exists()).toBe(true)
    const firstElBefore = firstRowBefore.element

    // -> A wholesale replacement: an unrelated result set with no keys in common with the first,
    //    same array length and same index-0 position -- exactly the "any filter change" case the
    //    bug description calls out.
    wrapper.vm.state.results = [
      resultItem('en', 'page-three', 'Page Three'),
      resultItem('en', 'page-four', 'Page Four')
    ]
    await flushPromises()

    const firstRowAfter = wrapper.find('a[href="/page-three"]')
    expect(firstRowAfter.exists()).toBe(true)
    expect(firstRowAfter.element).not.toBe(firstElBefore)

    // -> The stale row is gone outright, not merely relabeled in place
    expect(wrapper.find('a[href="/page-one"]').exists()).toBe(false)
  })
})
