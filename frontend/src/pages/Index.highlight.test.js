import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import Index from './Index.vue'
import { usePageStore } from '@/stores/page'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

/**
 * OpenProject #2541 (Feature #2539): the `?highlight=` query param, read by `Index.vue` and applied
 * to the rendered content via `helpers/renderedContent.js`'s `applyKeywordHighlight`. Covers the
 * route-query wiring, the "same component instance across two navigations" requirement, and the
 * dismiss/Escape/`router.replace` behavior -- not the wrap/unwrap logic itself, which
 * `renderedContent.highlight.test.js` already covers as pure DOM logic with no component involved.
 */

const STUBS = {
  PageHeader: true,
  PageActionsCol: true,
  PageToc: true,
  PageTags: true,
  SideDialog: true,
  PageRedirect: true,
  FooterNav: true,
  PageComments: true
}

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

  // -> jsdom does not implement `scrollIntoView` at all; `focusHighlightMatch` calls it on the
  //    current match unconditionally, so it has to exist as *something* to observe.
  Element.prototype.scrollIntoView = vi.fn()
})

let activeWrapper = null

afterEach(() => {
  activeWrapper?.unmount()
  activeWrapper = null
  vi.restoreAllMocks()
})

const MESSAGES = {
  common: {
    renderedContent: {
      highlightCount: '{current} of {total}',
      highlightDismiss: 'Clear highlight',
      highlightNext: 'Next match',
      highlightPrevious: 'Previous match'
    }
  }
}

async function mountAt(initialPath) {
  setActivePinia(createPinia())
  const router = await createTestRouter(['/:pathMatch(.*)*'], initialPath)
  const i18n = createTestI18n(MESSAGES)

  const wrapper = mount(Index, {
    global: {
      plugins: [router, i18n],
      stubs: STUBS
    }
  })
  activeWrapper = wrapper

  return { wrapper, router, pageStore: usePageStore() }
}

/**
 * Mounts at `initialPath`, then puts a real page with `html` as its render on screen.
 *
 * The unmocked `API_CLIENT.get` stub resolves `undefined`, which the route watcher's own
 * `loadPageForRoute` (unrelated to this WP) reads as `ERR_PAGE_NOT_FOUND` and asynchronously flips
 * the store to `pageNotFound` state -- which would otherwise land AFTER a naive
 * `pageStore.render = html` set right after `mount()` and stomp it back to the missing-page screen.
 * `flushPromises()` first lets that doomed load run its course; only then is the store patched into
 * the state this suite actually wants to test against, with a second `flushPromises()` for this WP's
 * own `nextTick`-deferred highlight pass to run.
 */
async function mountWithContent(initialPath, html) {
  const mounted = await mountAt(initialPath)
  await flushPromises()
  mounted.pageStore.$patch({ notFound: false, editor: '', isLocked: false, render: html })
  await flushPromises()
  return mounted
}

describe('Index.vue: keyword highlight indicator (OpenProject #2541)', () => {
  it('does not render the indicator when there is no ?highlight= param', async () => {
    const { wrapper } = await mountWithContent('/some-page', '<p>Some foxes in a forest.</p>')

    expect(wrapper.find('.keyword-highlight-bar').exists()).toBe(false)
  })

  it('highlights every match and shows an "N of M" count once the page has rendered', async () => {
    const { wrapper } = await mountWithContent(
      '/some-page?highlight=foxes',
      '<p>Foxes and more foxes, out in the forest.</p>'
    )

    const marks = wrapper.findAll('mark.keyword-highlight')
    expect(marks).toHaveLength(2)

    const bar = wrapper.find('.keyword-highlight-bar')
    expect(bar.exists()).toBe(true)
    expect(bar.text()).toContain('1 of 2')
    // -> The first match starts out current
    expect(marks[0].classes()).toContain('is-current-match')
  })

  it('shows a "0 of 0" indicator, not nothing, when the term is not found on this page', async () => {
    const { wrapper } = await mountWithContent(
      '/some-page?highlight=zzz-not-present',
      '<p>Nothing relevant here.</p>'
    )

    const bar = wrapper.find('.keyword-highlight-bar')
    expect(bar.exists()).toBe(true)
    expect(bar.text()).toContain('0 of 0')
  })

  it('next/previous move the current match and wrap around at the ends', async () => {
    const { wrapper } = await mountWithContent('/some-page?highlight=cat', '<p>cat cat cat</p>')

    const currentText = () => wrapper.find('.keyword-highlight-bar-count').text()
    expect(currentText()).toBe('1 of 3')

    const [prevBtn, nextBtn] = wrapper.findAllComponents({ name: 'WBtn' }).filter((c) => {
      const label = c.attributes('aria-label')
      return label === 'Previous match' || label === 'Next match'
    })

    await nextBtn.trigger('click')
    expect(currentText()).toBe('2 of 3')

    await nextBtn.trigger('click')
    await nextBtn.trigger('click')
    // -> Wrapped back to the first match
    expect(currentText()).toBe('1 of 3')

    await prevBtn.trigger('click')
    // -> Wrapped the other way, to the last match
    expect(currentText()).toBe('3 of 3')
  })

  it('re-runs when the highlight param changes while Vue Router reuses this same component instance', async () => {
    const { wrapper, pageStore, router } = await mountWithContent(
      '/page-a?highlight=foxes',
      '<p>Foxes live here.</p>'
    )

    expect(wrapper.findAll('mark.keyword-highlight')).toHaveLength(1)
    expect(wrapper.find('.keyword-highlight-bar-count').text()).toBe('1 of 1')

    // -> A second graph-node click while already on a content page: the route changes (a new
    //    highlight term, possibly a new path too), but this is the SAME mounted `Index.vue`
    //    instance -- Vue Router does not remount it for a sibling content-page navigation.
    await router.push('/page-a?highlight=wolves')
    pageStore.$patch({ notFound: false, render: '<p>Wolves live here too.</p>' })
    await flushPromises()

    const marks = wrapper.findAll('mark.keyword-highlight')
    expect(marks).toHaveLength(1)
    expect(marks[0].text()).toBe('Wolves')
    expect(wrapper.find('.keyword-highlight-bar-count').text()).toBe('1 of 1')
  })

  it('dismiss clears the marks, hides the indicator, and strips ?highlight= via router.replace (no new history entry)', async () => {
    const { wrapper, router } = await mountWithContent(
      '/some-page?highlight=foxes',
      '<p>Foxes in the forest.</p>'
    )

    const replaceSpy = vi.spyOn(router, 'replace')

    const dismissBtn = wrapper
      .findAllComponents({ name: 'WBtn' })
      .find((c) => c.attributes('aria-label') === 'Clear highlight')
    await dismissBtn.trigger('click')
    await flushPromises()

    expect(wrapper.find('.keyword-highlight-bar').exists()).toBe(false)
    expect(wrapper.findAll('mark.keyword-highlight')).toHaveLength(0)
    expect(wrapper.text()).toContain('Foxes in the forest.')
    expect(replaceSpy).toHaveBeenCalledTimes(1)
    expect(router.currentRoute.value.query.highlight).toBeUndefined()
    expect(router.currentRoute.value.path).toBe('/some-page')
  })

  it('Escape dismisses the highlight the same way the close control does', async () => {
    const { wrapper, router } = await mountWithContent(
      '/some-page?highlight=foxes',
      '<p>Foxes in the forest.</p>'
    )

    expect(wrapper.find('.keyword-highlight-bar').exists()).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()

    expect(wrapper.find('.keyword-highlight-bar').exists()).toBe(false)
    expect(router.currentRoute.value.query.highlight).toBeUndefined()
  })

  it('Escape does nothing when there is no active highlight to dismiss', async () => {
    const { wrapper, router } = await mountWithContent('/some-page', '<p>Nothing to highlight.</p>')

    const replaceSpy = vi.spyOn(router, 'replace')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()

    expect(replaceSpy).not.toHaveBeenCalled()
    expect(wrapper.find('.keyword-highlight-bar').exists()).toBe(false)
  })
})
