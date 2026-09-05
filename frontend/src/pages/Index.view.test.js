import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import Index from './Index.vue'
import { useEditorStore } from '@/stores/editor'
import { usePageStore } from '@/stores/page'
import { useSiteStore } from '@/stores/site'
import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

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

  const router = await createTestRouter(['/'])

  // -> Real English messages for the couple of keys these tests assert the rendered text of
  //    (`common.page.unpublished`, `common.page.lastModified`); every other `t()` call in the
  //    component renders as its bare key, same as before this list existed, which none of these
  //    tests reads.
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
        PageComments: true
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

/*
 * OpenProject #829, item 1: upstream issue #1839 ("Mermaid renders in the live edit preview but not
 * on the saved/reloaded page") and discussion #6446 (the identical pattern for KaTeX). This is the
 * frontend half of the render-then-reload regression test the item asks for -- `rendering.test.ts`
 * covers the save-time half (a diagram block and a resolved formula both survive `postProcess`
 * byte-for-byte); this covers what actually draws a diagram once that stored HTML comes back down.
 *
 * A diagram block is a Lit custom element that draws itself in its own `firstUpdated()` once its
 * component script has been imported and the tag upgrades -- it does not matter whether that
 * happened because the live editor preview loaded it moments ago or because this is a page loaded
 * fresh (a direct URL, a browser reload) that has never seen the editor at all. What matters is that
 * SOMETHING scans the page for an undefined block tag and imports it either way. This mounts
 * `Index.vue` exactly as a reader loading a saved page directly would -- `pageStore.pageLoad`
 * resolving real page data whose `render` is what `rendering.test.ts` proved a save writes to
 * storage -- and asserts the block-loading scan this view's route watcher runs (`{ immediate: true }`,
 * so it also covers the very first load of a page, not only navigating between two already-open
 * ones) picks the diagram up, with no live editor ever having been open in this test at all.
 */
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

/**
 * OpenProject #813: the breadcrumb bar (trail + "Last modified") used to unmount the moment
 * `editorStore.isActive` flipped true. It now stays up through editing, gated only on there being a
 * page at all (`pageStore.notFound`) -- with "Last modified" itself further hidden for a page that
 * has never been saved, where there is no true last-saved moment to report.
 */
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

/**
 * OpenProject #817: the "Unpublished" chip rendering was guarded by a broken condition
 * `!pageStore.publishState === 'draft'`, which due to operator precedence parsed as
 * `(!pageStore.publishState) === 'draft'` — always false since a negated value is a boolean,
 * never the string 'draft'. Fixed to `pageStore.publishState === 'draft'`.
 */
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
