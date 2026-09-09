import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import Index from './Index.vue'
import { usePageStore } from '@/stores/page'

import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

/**
 * OpenProject #2901: a `?highlight=` term forwarded from a graph-node click (OpenProject #2541,
 * Feature #2539) is applied to the article body via `helpers/renderedContent.js`'s
 * `applyKeywordHighlight`, but the page title -- a completely separate DOM subtree drawn by
 * `PageHeader.vue` -- was never scanned. This is the same suite `Index.highlight.test.js` covers,
 * deliberately split out because it needs `PageHeader` mounted for real (that file stubs it) --
 * `Index.pageHeaderCobalt.test.js` establishes that `PageHeader` mounts standalone with no extra
 * stubbing required.
 */

const STUBS = {
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
 * Mounts at `initialPath`, then puts a real page -- title included -- with `html` as its render on
 * screen. See `Index.highlight.test.js#mountWithContent`'s own header comment for why the loading
 * dance below (an unmocked `API_CLIENT.get` resolving into a doomed `pageNotFound` state first) is
 * necessary.
 */
async function mountWithContent(initialPath, { title, html }) {
  const mounted = await mountAt(initialPath)
  await flushPromises()
  mounted.pageStore.$patch({ notFound: false, editor: '', isLocked: false, title, render: html })
  await flushPromises()
  return mounted
}

describe('Index.vue: keyword highlight includes the page title (OpenProject #2901)', () => {
  it('wraps a match in the title the same as one in the body, on first load', async () => {
    const { wrapper } = await mountWithContent('/some-page?highlight=foxes', {
      title: 'Foxes of the Forest',
      html: '<p>An article about clever foxes.</p>'
    })

    const titleMark = wrapper.find('.page-header-title mark.keyword-highlight')
    expect(titleMark.exists()).toBe(true)
    expect(titleMark.text()).toBe('Foxes')

    const bodyMark = wrapper.find('.page-contents mark.keyword-highlight')
    expect(bodyMark.exists()).toBe(true)
  })

  it('counts the title match toward the "N of M" indicator, title first', async () => {
    const { wrapper } = await mountWithContent('/some-page?highlight=fox', {
      title: 'The Fox',
      html: '<p>A fox in the forest.</p>'
    })

    expect(wrapper.find('.keyword-highlight-bar-count').text()).toBe('1 of 2')

    const marks = wrapper.findAll('mark.keyword-highlight')
    expect(marks).toHaveLength(2)
    // -> Title-first ordering: the current match starts on the title's own mark.
    expect(marks[0].element.closest('.page-header-title')).not.toBeNull()
    expect(marks[0].classes()).toContain('is-current-match')
  })

  it('next/previous step through the title match and the body match together', async () => {
    const { wrapper } = await mountWithContent('/some-page?highlight=fox', {
      title: 'The Fox',
      html: '<p>A fox in the forest.</p>'
    })

    const currentText = () => wrapper.find('.keyword-highlight-bar-count').text()
    expect(currentText()).toBe('1 of 2')

    const nextBtn = wrapper
      .findAllComponents({ name: 'WBtn' })
      .find((c) => c.attributes('aria-label') === 'Next match')
    await nextBtn.trigger('click')

    expect(currentText()).toBe('2 of 2')
    const marks = wrapper.findAll('mark.keyword-highlight')
    expect(marks[1].element.closest('.page-contents')).not.toBeNull()
    expect(marks[1].classes()).toContain('is-current-match')
  })

  it('dismiss clears the title mark as well as the body mark', async () => {
    const { wrapper } = await mountWithContent('/some-page?highlight=fox', {
      title: 'The Fox',
      html: '<p>A fox in the forest.</p>'
    })

    expect(wrapper.findAll('mark.keyword-highlight')).toHaveLength(2)

    const dismissBtn = wrapper
      .findAllComponents({ name: 'WBtn' })
      .find((c) => c.attributes('aria-label') === 'Clear highlight')
    await dismissBtn.trigger('click')
    await flushPromises()

    expect(wrapper.findAll('mark.keyword-highlight')).toHaveLength(0)
    expect(wrapper.find('.page-header-title').text()).toContain('The Fox')
  })

  it('re-syncs the title highlight when the title itself changes without the route moving', async () => {
    const { wrapper, pageStore } = await mountWithContent('/some-page?highlight=fox', {
      title: 'The Fox',
      html: '<p>Nothing here.</p>'
    })

    expect(wrapper.find('.page-header-title mark.keyword-highlight').exists()).toBe(true)

    pageStore.$patch({ title: 'A Wolf' })
    await flushPromises()

    expect(wrapper.find('.page-header-title mark.keyword-highlight').exists()).toBe(false)
    expect(wrapper.find('.page-header-title').text()).toContain('A Wolf')
  })

  it('finds no title match when the term is only in the body', async () => {
    const { wrapper } = await mountWithContent('/some-page?highlight=forest', {
      title: 'Getting Started',
      html: '<p>Deep in the forest.</p>'
    })

    expect(wrapper.find('.page-header-title mark.keyword-highlight').exists()).toBe(false)
    expect(wrapper.find('.keyword-highlight-bar-count').text()).toBe('1 of 1')
  })
})
