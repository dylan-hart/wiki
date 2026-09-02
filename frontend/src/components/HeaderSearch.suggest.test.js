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
