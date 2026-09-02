import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import HeaderSearch from './HeaderSearch.vue'
import { useSiteStore } from '@/stores/site'
import { copyToClipboard } from '@/helpers/clipboard'
import { queue as notifyQueue } from '@/composables/notify'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

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
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.features.search = true
  siteStore.tagsLoaded = true
  siteStore.tags = tags

  const router = await createTestRouter(['/'])

  const i18n = createTestI18n()

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

/**
 * OpenProject #987, #1120, #1218: the browse-by-tags entry point, moved here from `HeaderNav.vue`
 * (`HeaderNav.test.js` asserts it no longer renders one of its own) so it can dock flush against the
 * search field's right edge, matching the 2.5.x reference layout -- `la:tags` rather than the
 * previous `la:hashtag`, which read as a `#` operator glyph rather than a tag shape.
 */
describe('HeaderSearch "Browse by tags" entry point (OpenProject #1218)', () => {
  it('renders a link to /_tags docked against the field, unconditionally', async () => {
    const wrapper = await mountWithTags([])

    const tagsLink = wrapper.find('.header-search-tags-btn')
    expect(tagsLink.exists()).toBe(true)
    expect(tagsLink.attributes('href')).toBe('/_tags')
  })

  it('uses the la:tags icon, not la:hashtag', async () => {
    const wrapper = await mountWithTags([])

    expect(wrapper.find('.header-search-tags-btn [data-icon]').attributes('data-icon')).toBe(
      'la:tags'
    )
  })

  it('does not render in row (phone) form, which has no room to dock a second control', async () => {
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    siteStore.features.search = true

    const router = await createTestRouter(['/'])

    const i18n = createTestI18n()
    const wrapper = mount(HeaderSearch, {
      props: { row: true },
      global: { plugins: [router, i18n] }
    })

    expect(wrapper.find('.header-search-tags-btn').exists()).toBe(false)
  })
})

/**
 * OpenProject #2050: `handleKeyPress` only ever tested `ev.ctrlKey`, so Cmd+K did nothing on macOS --
 * worse, Ctrl+K there is the OS's own emacs kill-to-end-of-line binding, already claimed. These
 * assert both modifiers now focus the field, and that the hint (previously hardcoded, always
 * "Ctrl+K") follows a stubbed `navigator.platform`.
 */
describe('HeaderSearch keyboard shortcut (OpenProject #2050)', () => {
  let activeWrapper = null

  afterEach(() => {
    activeWrapper?.unmount()
    activeWrapper = null
    vi.restoreAllMocks()
  })

  async function mountAttached() {
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    siteStore.features.search = true

    const router = await createTestRouter(['/'])

    const i18n = createTestI18n()

    const wrapper = mount(HeaderSearch, {
      global: { plugins: [router, i18n] },
      attachTo: document.body
    })
    activeWrapper = wrapper
    return wrapper
  }

  it('focuses the field on Ctrl+K', async () => {
    const wrapper = await mountAttached()
    const input = wrapper.find('.header-search-input').element

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
    await wrapper.vm.$nextTick()

    expect(document.activeElement).toBe(input)
  })

  it('also focuses the field on Cmd+K (metaKey) -- previously unbound entirely', async () => {
    const wrapper = await mountAttached()
    const input = wrapper.find('.header-search-input').element

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    await wrapper.vm.$nextTick()

    expect(document.activeElement).toBe(input)
  })

  it('marks the field aria-keyshortcuts for both modifiers', async () => {
    const wrapper = await mountAttached()

    expect(wrapper.find('.header-search-input').attributes('aria-keyshortcuts')).toBe(
      'Meta+K Control+K'
    )
  })

  it('renders the Ctrl+K hint on a non-Apple platform', async () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Win32')

    const wrapper = await mountAttached()

    expect(wrapper.find('.header-search-kbd').text()).toBe('common.header.searchShortcutOther')
  })

  it('renders the platform-aware ⌘K hint on an Apple platform', async () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel')

    const wrapper = await mountAttached()

    expect(wrapper.find('.header-search-kbd').text()).toBe('common.header.searchShortcutMac')
  })
})

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
 * OpenProject #830 (upstream PR #7688): a browser's password manager offers to fill a "username +
 * password" pair into whatever looks like a login form on the page, and without a signal telling it
 * otherwise a plain, unlabeled text field like this one can get scooped up as the "username" half --
 * autofilling a stray credential into the header search box. `autocomplete="off"` is the field's own
 * opt-out signal; this pins it as a regression test since nothing else about this field (no `name`,
 * no `type="search"`, sitting right next to the header's own controls) would otherwise stop a browser
 * from trying.
 */
describe('HeaderSearch autofill', () => {
  it('marks the input autocomplete="off" so password managers do not offer to fill it', async () => {
    const wrapper = await mountWithTags([])

    expect(wrapper.find('.header-search-input').attributes('autocomplete')).toBe('off')
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
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    siteStore.id = 'site1'
    siteStore.features.search = true
    siteStore.tagsLoaded = true
    siteStore.tags = []

    const router = await createTestRouter(['/'])

    const i18n = createTestI18n()

    const wrapper = mount(HeaderSearch, {
      props: { row: true },
      global: { plugins: [router, i18n] }
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
 * "Did you mean": the backend's `pages/search` response carries a `suggestion` (closest page title
 * by trigram similarity) only when a real query found nothing. The panel's empty-preview state shows
 * it as a clickable prompt that replaces the current query with the suggestion and re-runs the
 * search -- same mousedown-prevent trick as the result rows above, so the click survives the field's
 * blur.
 */
describe('HeaderSearch did-you-mean suggestion', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the suggestion once a zero-hit query comes back with one', async () => {
    const { wrapper } = await mountForPreview()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [], totalHits: 0, suggestion: 'Foo Bar' })
    })

    await wrapper.find('.header-search-input').setValue('foo baz')
    await vi.advanceTimersByTimeAsync(400)

    expect(wrapper.text()).toContain('common.header.searchDidYouMean')
    expect(wrapper.text()).toContain('Foo Bar')
  })

  it('does not show a suggestion line when the backend gives none', async () => {
    const { wrapper } = await mountForPreview()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [], totalHits: 0 })
    })

    await wrapper.find('.header-search-input').setValue('zz')
    await vi.advanceTimersByTimeAsync(400)

    expect(wrapper.find('.searchpanel-suggestion-link').exists()).toBe(false)
  })

  it('clicking the suggestion replaces the query and re-runs the search', async () => {
    const { wrapper, siteStore } = await mountForPreview()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [], totalHits: 0, suggestion: 'Foo Bar' })
    })

    await wrapper.find('.header-search-input').setValue('foo baz')
    await vi.advanceTimersByTimeAsync(400)

    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({ results: [{ path: 'foo-bar', title: 'Foo Bar' }], totalHits: 1 })
    })

    const suggestionLink = wrapper.find('.searchpanel-suggestion-link')
    const mousedownEvent = new Event('mousedown', { bubbles: true, cancelable: true })
    suggestionLink.element.dispatchEvent(mousedownEvent)
    expect(mousedownEvent.defaultPrevented).toBe(true)

    await suggestionLink.trigger('click')
    expect(siteStore.search).toBe('Foo Bar')

    await vi.advanceTimersByTimeAsync(400)

    expect(API_CLIENT.get).toHaveBeenCalledTimes(2)
    expect(wrapper.vm.state.previewResults).toEqual([{ path: 'foo-bar', title: 'Foo Bar' }])
    expect(wrapper.find('.searchpanel-suggestion-link').exists()).toBe(false)
  })

  it('resets the suggestion when the field is cleared', async () => {
    const { wrapper } = await mountForPreview()
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ results: [], totalHits: 0, suggestion: 'Foo Bar' })
    })

    await wrapper.find('.header-search-input').setValue('foo baz')
    await vi.advanceTimersByTimeAsync(400)
    expect(wrapper.vm.state.previewSuggestion).toBe('Foo Bar')

    await wrapper.find('.header-search-clear').trigger('click')

    expect(wrapper.vm.state.previewSuggestion).toBe(null)
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
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    siteStore.id = 'site1'
    siteStore.features.search = true
    siteStore.tagsLoaded = true
    siteStore.tags = [{ tag: 'foo', usageCount: 1 }]

    const router = await createTestRouter(['/'])

    const i18n = createTestI18n()
    const wrapper = mount(HeaderSearch, { global: { plugins: [router, i18n] } })

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

/**
 * "Copy Search Link": a small icon button next to the results-count line, visible only once
 * `siteStore.search` is non-empty, that builds the shareable `/_search?q=` URL `Search.vue`'s route
 * watcher already reads and copies it via the `copyToClipboard` helper -- mirroring
 * `ApiKeyCopyDialog.vue`'s `copyKey()` try/catch + `notify()` pattern.
 */
describe('HeaderSearch copy search link', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    notifyQueue.splice(0, notifyQueue.length)
    copyToClipboard.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not render the copy-link button while the field is empty', async () => {
    const { wrapper } = await mountForPreview()

    expect(wrapper.find('.header-search-copy-link').exists()).toBe(false)
  })

  it('renders the copy-link button, aria-labeled, below the 2-character preview floor', async () => {
    // -> Below `PREVIEW_QUERY_MIN_LENGTH`, none of the loading/empty/found states have anything to
    //    show -- proving the button's visibility is gated on `siteStore.search` alone, not on those.
    const { wrapper } = await mountForPreview()

    await wrapper.find('.header-search-input').setValue('a')

    const button = wrapper.find('.header-search-copy-link')
    expect(button.exists()).toBe(true)
    expect(button.attributes('aria-label')).toBe('common.header.searchCopyLink')
    expect(API_CLIENT.get).not.toHaveBeenCalled()
  })

  it('copies the shareable search URL and shows a success notification on click', async () => {
    copyToClipboard.mockResolvedValueOnce()
    const { wrapper, siteStore } = await mountForPreview()

    await wrapper.find('.header-search-input').setValue('ab')
    await wrapper.find('.header-search-copy-link').trigger('click')
    await vi.advanceTimersByTimeAsync(0)

    expect(copyToClipboard).toHaveBeenCalledWith(
      `${window.location.origin}/_search?q=${encodeURIComponent(siteStore.search)}`
    )
    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'positive',
      message: 'common.clipboard.success'
    })
  })

  it('shows a failure notification when the copy rejects', async () => {
    copyToClipboard.mockRejectedValueOnce(new Error('denied'))
    const { wrapper } = await mountForPreview()

    await wrapper.find('.header-search-input').setValue('ab')
    await wrapper.find('.header-search-copy-link').trigger('click')
    await vi.advanceTimersByTimeAsync(0)

    expect(notifyQueue.at(-1)).toMatchObject({
      type: 'negative',
      message: 'common.clipboard.failure',
      caption: 'denied'
    })
  })

  it('prevents the mousedown default so the click survives the field blur', async () => {
    const { wrapper } = await mountForPreview()

    await wrapper.find('.header-search-input').setValue('ab')

    const button = wrapper.find('.header-search-copy-link')
    const event = new Event('mousedown', { bubbles: true, cancelable: true })
    button.element.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
  })
})
