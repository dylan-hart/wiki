import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'

import HeaderSearch from './HeaderSearch.vue'
import { useSiteStore } from '@/stores/site'

/**
 * Regression test for the `popularTags` computed (not part of the backend `FIXME:` list this branch's
 * test infra otherwise regression-tests — see CLAUDE.md's "Testing (backend)" section — this is the
 * fifth, frontend bug the epic separately tracks). It must sort by usage count DESCENDING, most-used
 * first: `orderBy(siteStore.tags, ['usageCount', 'desc'], ['asc', 'asc'])` passed the string `'desc'`
 * as a second sort KEY (es-toolkit's `orderBy(collection, iteratees[], orders[])` has no such
 * property on a tag) rather than as the ORDER for `usageCount`, so every tag sorted ascending by
 * usage — the opposite of "popular" — regardless of what order strings were written after it.
 */
async function mountWithTags(tags) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.features.search = true
  siteStore.tagsLoaded = true
  siteStore.tags = tags

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }]
  })
  router.push('/')
  await router.isReady()

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  const wrapper = mount(HeaderSearch, {
    global: {
      plugins: [router, i18n]
    }
  })

  // -> The panel (and the popular-tags list inside it) only renders once the field is focused --
  //    mirrors what a real user does, rather than reaching into component internals for the flag.
  await wrapper.find('.header-search-input').trigger('focus')

  return wrapper
}

describe('HeaderSearch popularTags', () => {
  it('sorts tags by usage count descending, most-used first', async () => {
    const wrapper = await mountWithTags([
      { tag: 'a', usageCount: 1 },
      { tag: 'b', usageCount: 5 },
      { tag: 'c', usageCount: 3 }
    ])

    const renderedTags = wrapper.findAll('.w-chip').map((chip) => chip.text().trim())

    expect(renderedTags).toEqual(['b', 'c', 'a'])
  })
})

/**
 * The debounced live-preview fetch: typing into the focused field, once the query reaches the
 * 2-character floor `searchHint`'s copy already promises, should fetch a handful of matching pages
 * from `sites/:id/pages/search` and land them in `state.previewResults` -- without ever letting a
 * slower, earlier request clobber a faster, later one, and without leaving a request in flight past
 * `clearSearch()` or unmount.
 */
async function mountForPreview() {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site1'
  siteStore.features.search = true
  siteStore.tagsLoaded = true
  siteStore.tags = []

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div />' } }]
  })
  router.push('/')
  await router.isReady()

  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: {} } })

  const wrapper = mount(HeaderSearch, {
    global: {
      plugins: [router, i18n]
    }
  })

  await wrapper.find('.header-search-input').trigger('focus')

  return { wrapper, siteStore }
}

describe('HeaderSearch live-preview fetch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not fetch below the 2-character floor', async () => {
    const { wrapper } = await mountForPreview()

    await wrapper.find('.header-search-input').setValue('a')
    await vi.advanceTimersByTimeAsync(400)

    expect(API_CLIENT.get).not.toHaveBeenCalled()
    expect(wrapper.vm.state.previewResults).toEqual([])
    expect(wrapper.vm.state.previewLoading).toBe(false)
  })

  it('fetches a debounced preview once the query reaches 2 characters', async () => {
    const { wrapper, siteStore } = await mountForPreview()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [{ path: 'foo' }], totalHits: 1 })
    })

    await wrapper.find('.header-search-input').setValue('ab')

    // -> Not fired yet -- still inside the debounce window
    expect(API_CLIENT.get).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(400)

    expect(API_CLIENT.get).toHaveBeenCalledTimes(1)
    expect(API_CLIENT.get).toHaveBeenCalledWith(`sites/${siteStore.id}/pages/search`, {
      searchParams: { query: 'ab', limit: 5 }
    })
    expect(wrapper.vm.state.previewResults).toEqual([{ path: 'foo' }])
    expect(wrapper.vm.state.previewTotal).toBe(1)
    expect(wrapper.vm.state.previewLoading).toBe(false)
  })

  it('drops a stale response that resolves after a newer one', async () => {
    const { wrapper } = await mountForPreview()
    let resolveFirst
    let resolveSecond
    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve
    })
    const secondPromise = new Promise((resolve) => {
      resolveSecond = resolve
    })
    API_CLIENT.get
      .mockReturnValueOnce({ json: () => firstPromise })
      .mockReturnValueOnce({ json: () => secondPromise })

    await wrapper.find('.header-search-input').setValue('ab')
    await vi.advanceTimersByTimeAsync(400)
    expect(API_CLIENT.get).toHaveBeenCalledTimes(1)

    await wrapper.find('.header-search-input').setValue('abc')
    await vi.advanceTimersByTimeAsync(400)
    expect(API_CLIENT.get).toHaveBeenCalledTimes(2)

    // -> Out-of-order: the newer ("abc") request settles first, the stale ("ab") one lands after
    resolveSecond({ results: [{ path: 'abc-page' }], totalHits: 1 })
    await vi.advanceTimersByTimeAsync(0)
    resolveFirst({ results: [{ path: 'ab-page' }], totalHits: 99 })
    await vi.advanceTimersByTimeAsync(0)

    expect(wrapper.vm.state.previewResults).toEqual([{ path: 'abc-page' }])
    expect(wrapper.vm.state.previewTotal).toBe(1)
  })

  it('resets preview state when the field is cleared', async () => {
    const { wrapper } = await mountForPreview()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [{ path: 'foo' }], totalHits: 1 })
    })

    await wrapper.find('.header-search-input').setValue('ab')
    await vi.advanceTimersByTimeAsync(400)
    expect(wrapper.vm.state.previewResults).toEqual([{ path: 'foo' }])

    await wrapper.find('.header-search-clear').trigger('click')

    expect(wrapper.vm.state.previewResults).toEqual([])
    expect(wrapper.vm.state.previewLoading).toBe(false)
    expect(wrapper.vm.state.previewTotal).toBe(0)
  })

  it('cancels the pending debounced fetch on unmount', async () => {
    const { wrapper } = await mountForPreview()

    await wrapper.find('.header-search-input').setValue('ab')
    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(400)

    expect(API_CLIENT.get).not.toHaveBeenCalled()
  })

  it('degrades to a quiet no-results state on a failed request', async () => {
    const { wrapper } = await mountForPreview()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.reject(new Error('network down'))
    })

    await wrapper.find('.header-search-input').setValue('ab')
    await vi.advanceTimersByTimeAsync(400)

    expect(wrapper.vm.state.previewResults).toEqual([])
    expect(wrapper.vm.state.previewLoading).toBe(false)
    expect(wrapper.vm.state.previewTotal).toBe(0)
  })
})
