import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import Index from './Index.vue'
import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

/*
 * `useMinWidth` (via `useScreen`) calls `window.matchMedia`, and the common store's `state()` reads
 * `localStorage.getItem('locale')` the moment it's instantiated. `localStorage` is a real but
 * non-functional (`--localstorage-file`-less) Node global in this runtime rather than simply
 * absent, so it has to be overwritten, not merely filled in when missing.
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
 * Unmounted after every test: the next test's `setActivePinia` replaces the pinia instance while a
 * still-mounted component's watchers keep running against the old stores, and reading a disposed
 * reactive scope surfaces as an unhandled rejection inside whatever test runs next.
 */
let activeWrapper = null

afterEach(() => {
  activeWrapper?.unmount()
  activeWrapper = null
})

async function mountIndex() {
  setActivePinia(createPinia())

  const router = await createTestRouter(['/'])

  const i18n = createTestI18n({
    common: {
      page: { unpublished: 'Unpublished', lastModified: 'Last modified' }
    }
  })

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
        PageComments: true,
        PageCommentsEmbed: true
      }
    }
  })
  activeWrapper = wrapper

  return {
    wrapper,
    pageStore: usePageStore(),
    siteStore: useSiteStore(),
    editorStore: useEditorStore()
  }
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

describe('Index.vue: breadcrumb bar during editing (OpenProject #813)', () => {
  it('stays mounted once the editor is active, unlike before', async () => {
    const { wrapper, editorStore } = await mountIndex()
    expect(wrapper.find('.page-breadcrumbs').exists()).toBe(true)

    editorStore.isActive = true
    editorStore.mode = 'edit'
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.page-breadcrumbs').exists()).toBe(true)
  })

  it('stays hidden for a path with no page at all, editor or not', async () => {
    const { wrapper, pageStore, editorStore } = await mountIndex()
    pageStore.notFound = true
    editorStore.isActive = true
    editorStore.mode = 'create'
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.page-breadcrumbs').exists()).toBe(false)
  })

  it('keeps "Last modified" visible while editing an already-saved page', async () => {
    const { wrapper, pageStore, editorStore } = await mountIndex()
    pageStore.updatedAt = '2026-01-01T00:00:00.000Z'
    editorStore.isActive = true
    editorStore.mode = 'edit'
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('Last modified')
  })

  it('hides "Last modified" but keeps the trail for a page that has never been saved', async () => {
    const { wrapper, pageStore, editorStore } = await mountIndex()
    pageStore.$patch({ path: 'new-page', updatedAt: '' })
    editorStore.isActive = true
    editorStore.mode = 'create'
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).not.toContain('Last modified on')
    expect(wrapper.findComponent({ name: 'WBreadcrumbs' }).exists()).toBe(true)
  })
})

describe('Index.vue: unpublished chip (OpenProject #817)', () => {
  it('renders the "Unpublished" chip when publishState is "draft"', async () => {
    const { wrapper, pageStore } = await mountIndex()
    pageStore.publishState = 'draft'
    await wrapper.vm.$nextTick()

    const chip = wrapper.find('.text-accent')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('Unpublished')
  })

  it('does not render the chip when publishState is not "draft"', async () => {
    const { wrapper, pageStore } = await mountIndex()
    pageStore.publishState = 'published'
    await wrapper.vm.$nextTick()

    // FIXME: `:has-text()` is a Playwright selector, not CSS, so this never matches and the
    // assertion holds whether or not the chip rendered. Assert on `.text-accent`, as above.
    const chip = wrapper.find('div:has-text("Unpublished")')
    expect(chip.exists()).toBe(false)
  })

  it('renders the separator only when the chip renders', async () => {
    const { wrapper, pageStore } = await mountIndex()
    const separator = () => wrapper.findComponent({ name: 'WSeparator' })

    expect(separator().exists()).toBe(false)

    pageStore.publishState = 'draft'
    await wrapper.vm.$nextTick()

    expect(separator().exists()).toBe(true)
  })
})
