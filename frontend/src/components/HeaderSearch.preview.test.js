import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import HeaderSearch from './HeaderSearch.vue'
import { useSiteStore } from '@/stores/site'
import { copyToClipboard } from '@/helpers/clipboard'
import { queue as notifyQueue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

vi.mock('@/helpers/clipboard', () => ({
  copyToClipboard: vi.fn()
}))

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
  const router = await createTestRouter(['/'])

  const { wrapper } = mountWithApp(HeaderSearch, {
    router,
    stores: {
      site: (store) => {
        store.features.search = true
        store.tagsLoaded = true
        store.tags = tags
      }
    }
  })

  // -> The panel (and the popular-tags list inside it) only renders once the field is focused --
  //    mirrors what a real user does, rather than reaching into component internals for the flag.
  await wrapper.find('.header-search-input').trigger('focus')

  return wrapper
}
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

  const router = await createTestRouter(['/'])

  const i18n = createTestI18n()

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

/**
 * The panel's results section itself: it must reflect `state.previewLoading` /
 * `state.previewResults` / `state.previewTotal` with the three states the task describes -- loading,
 * empty, and populated -- and each populated row must be a navigable link that survives the mousedown
 * that would otherwise blur the field and close the panel before the click registers.
 */
describe('HeaderSearch preview results panel', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows a loading message with a spinner while the preview fetch is in flight', async () => {
    const { wrapper } = await mountForPreview()
    let resolveFetch
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        new Promise((resolve) => {
          resolveFetch = resolve
        })
    })

    await wrapper.find('.header-search-input').setValue('ab')
    await vi.advanceTimersByTimeAsync(400)

    expect(wrapper.vm.state.previewLoading).toBe(true)
    expect(wrapper.text()).toContain('common.header.searchLoading')
    expect(wrapper.find('.searchpanel .w-circular-progress').exists()).toBe(true)

    resolveFetch({ results: [], totalHits: 0 })
    await vi.advanceTimersByTimeAsync(0)
  })

  it('shows a no-results message once a real query comes back with zero hits', async () => {
    const { wrapper } = await mountForPreview()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [], totalHits: 0 })
    })

    await wrapper.find('.header-search-input').setValue('zz')
    await vi.advanceTimersByTimeAsync(400)

    expect(wrapper.text()).toContain('common.header.searchNoResult')
  })

  it('does not show the no-results message below the 2-character floor', async () => {
    const { wrapper } = await mountForPreview()

    await wrapper.find('.header-search-input').setValue('z')
    await vi.advanceTimersByTimeAsync(400)

    expect(wrapper.text()).not.toContain('common.header.searchNoResult')
  })

  it('renders result rows (icon, title, path, highlight) plus a results-count line', async () => {
    const { wrapper } = await mountForPreview()
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          results: [
            { path: 'foo/bar', title: 'Foo Bar', icon: 'mdi:file', highlight: 'a <b>match</b>' }
          ],
          totalHits: 12
        })
    })

    await wrapper.find('.header-search-input').setValue('ab')
    await vi.advanceTimersByTimeAsync(400)

    const rows = wrapper.findAll('.searchpanel-results .w-item')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('Foo Bar')
    expect(rows[0].text()).toContain('foo/bar')
    expect(rows[0].find('.text-highlight').html()).toContain('match')
    expect(wrapper.text()).toContain('common.header.searchResultsCount')
  })

  it('falls back to the default page icon when a result has none', async () => {
    const { wrapper } = await mountForPreview()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [{ path: 'foo', title: 'Foo' }], totalHits: 1 })
    })

    await wrapper.find('.header-search-input').setValue('ab')
    await vi.advanceTimersByTimeAsync(400)

    expect(wrapper.find('.searchpanel-results .w-item [data-icon]').attributes('data-icon')).toBe(
      'mdi:file-document-outline'
    )
  })

  it('caps rendered rows at 5 even if more results are present in state', async () => {
    const { wrapper } = await mountForPreview()

    await wrapper.find('.header-search-input').setValue('ab')
    wrapper.vm.state.previewResults = Array.from({ length: 7 }, (_, i) => ({
      path: `p${i}`,
      title: `T${i}`
    }))
    wrapper.vm.state.previewTotal = 7
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('.searchpanel-results .w-item')).toHaveLength(5)
  })

  it('prevents the mousedown default on a result row so the click survives the field blur', async () => {
    const { wrapper } = await mountForPreview()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [{ path: 'foo', title: 'Foo' }], totalHits: 1 })
    })

    await wrapper.find('.header-search-input').setValue('ab')
    await vi.advanceTimersByTimeAsync(400)

    const row = wrapper.find('.searchpanel-results .w-item')
    const event = new Event('mousedown', { bubbles: true, cancelable: true })
    row.element.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('still renders the results panel in row (phone) form factor', async () => {
    const router = await createTestRouter(['/'])

    const { wrapper } = mountWithApp(HeaderSearch, {
      props: { row: true },
      router,
      stores: {
        site: (store) => {
          store.id = 'site1'
          store.features.search = true
          store.tagsLoaded = true
          store.tags = []
        }
      }
    })

    await wrapper.find('.header-search-input').trigger('focus')
    expect(wrapper.find('.header-search-field--row').exists()).toBe(true)

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [{ path: 'foo', title: 'Foo' }], totalHits: 1 })
    })
    await wrapper.find('.header-search-input').setValue('ab')
    await vi.advanceTimersByTimeAsync(400)

    expect(wrapper.findAll('.searchpanel-results .w-item')).toHaveLength(1)
  })
})

/**
 * Task 569 edge cases: a query that is entirely the tips' own operator/tag syntax must not fire a
 * preview fetch just because its raw length clears the floor; a fetch already in flight when the
 * field is cleared by typing (not just the clear button) must not repopulate the panel once it
 * settles; and long result text must be ellipsised rather than blowing out the panel's fixed width.
 */
describe('HeaderSearch preview edge cases', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(['-a', '!a', '#a', '*', '""'])(
    'does not fetch for %s, which trims to under 2 real characters once operators are stripped',
    async (query) => {
      const { wrapper } = await mountForPreview()

      await wrapper.find('.header-search-input').setValue(query)
      await vi.advanceTimersByTimeAsync(400)

      expect(API_CLIENT.get).not.toHaveBeenCalled()
      expect(wrapper.vm.state.previewResults).toEqual([])
      expect(wrapper.vm.state.previewLoading).toBe(false)
      // -> Tag/operator tips still shown -- not the "no results" message, which would be wrong here
      expect(wrapper.text()).not.toContain('common.header.searchNoResult')
    }
  )

  it.each(['-ab', '!ab', '#ab'])(
    'still fetches for %s, which leaves 2 real characters once the operator is stripped',
    async (query) => {
      const { wrapper, siteStore } = await mountForPreview()
      API_CLIENT.get.mockReturnValueOnce({
        json: () => Promise.resolve({ results: [], totalHits: 0 })
      })

      await wrapper.find('.header-search-input').setValue(query)
      await vi.advanceTimersByTimeAsync(400)

      // -> The raw query, operators included, is what actually reaches the backend
      expect(API_CLIENT.get).toHaveBeenCalledWith(`sites/${siteStore.id}/pages/search`, {
        searchParams: { query, limit: 5 }
      })
    }
  )

  it('does not flash stale results after the field is cleared by typing while a fetch is in flight', async () => {
    const { wrapper } = await mountForPreview()
    let resolveFetch
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        new Promise((resolve) => {
          resolveFetch = resolve
        })
    })

    await wrapper.find('.header-search-input').setValue('ab')
    await vi.advanceTimersByTimeAsync(400)
    expect(API_CLIENT.get).toHaveBeenCalledTimes(1)
    expect(wrapper.vm.state.previewLoading).toBe(true)

    // -> Cleared by backspacing to empty, not via the clear button -- exercises the watcher's own
    //    below-the-floor branch, not `clearSearch()`
    await wrapper.find('.header-search-input').setValue('')
    expect(wrapper.vm.state.previewResults).toEqual([])
    expect(wrapper.vm.state.previewLoading).toBe(false)

    // -> The in-flight request for "ab" now settles, after the field was already emptied
    resolveFetch({ results: [{ path: 'ab-page' }], totalHits: 1 })
    await vi.advanceTimersByTimeAsync(0)

    expect(wrapper.vm.state.previewResults).toEqual([])
    expect(wrapper.vm.state.previewLoading).toBe(false)
    expect(wrapper.vm.state.previewTotal).toBe(0)
  })

  it('ellipsises long titles, paths and highlights instead of wrapping the row', async () => {
    const { wrapper } = await mountForPreview()
    const longTitle = 'A '.repeat(80).trim()
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          results: [
            {
              path: 'very/long/'.repeat(20) + 'page',
              title: longTitle,
              highlight: 'x '.repeat(80).trim()
            }
          ],
          totalHits: 1
        })
    })

    await wrapper.find('.header-search-input').setValue('ab')
    await vi.advanceTimersByTimeAsync(400)

    const labels = wrapper.findAll('.searchpanel-results .w-item-label')
    expect(labels.length).toBeGreaterThanOrEqual(3)
    for (const label of labels) {
      expect(label.classes()).toContain('truncate')
    }
  })

  it('keeps results, popular tags and operator tips together in one scrollable panel', async () => {
    const router = await createTestRouter(['/'])

    const { wrapper } = mountWithApp(HeaderSearch, {
      router,
      stores: {
        site: (store) => {
          store.id = 'site1'
          store.features.search = true
          store.tagsLoaded = true
          store.tags = [{ tag: 'foo', usageCount: 1 }]
        }
      }
    })

    await wrapper.find('.header-search-input').trigger('focus')
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          results: Array.from({ length: 5 }, (_, i) => ({ path: `p${i}`, title: `T${i}` })),
          totalHits: 5
        })
    })
    await wrapper.find('.header-search-input').setValue('ab')
    await vi.advanceTimersByTimeAsync(400)

    const panels = wrapper.findAll('.searchpanel')
    expect(panels).toHaveLength(1)
    const panel = panels[0]
    expect(panel.findAll('.searchpanel-results .w-item')).toHaveLength(5)
    expect(panel.findAll('.w-chip').length).toBeGreaterThan(0)
    expect(panel.findAll('.searchpanel-tip').length).toBeGreaterThan(0)
  })
})
