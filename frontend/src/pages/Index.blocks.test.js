import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import Index from './Index.vue'
import { useCommonStore } from '@/stores/common'
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
describe('Index.vue: read-path block loading for a directly-loaded/reloaded page (OpenProject #829 item 1)', () => {
  it('loads a block found only in the stored page render, never having gone through the live editor preview', async () => {
    setActivePinia(createPinia())

    const commonStore = useCommonStore()
    const loadBlocksSpy = vi.spyOn(commonStore, 'loadBlocks').mockResolvedValue(undefined)

    // -> The block-loading scan resolves `block-diagram` off `siteStore.blocksIndex` (a public
    //    field on the site-info response every reader's browser already has -- see
    //    `siteBlocksInfoFor` in `backend/api/sites.ts`, OpenProject #954) rather than a network
    //    call. Set directly here rather than via `applySiteInfo`, since nothing else this test
    //    checks needs a full site-info payload. A tag absent from this index is skipped entirely
    //    since OpenProject #1729, so it has to be present for this test's block to load at all.
    const siteStore = useSiteStore()
    siteStore.blocksIndex = { diagram: { id: null, isCustom: false } }

    // -> The shape `rendering.postProcess` actually stores: the block element plus its fenced
    //    mermaid source, exactly as a reload's GET would hand it back -- see
    //    `rendering.test.ts`'s "render, save, reload" describe block for where this shape comes from.
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          id: 'page-1',
          path: 'diagram-page',
          editor: 'markdown',
          render:
            '<p>Some text.</p>' +
            '<block-diagram theme="auto"><pre class="codeblock-mermaid"><code>A --&gt; B</code></pre></block-diagram>',
          relations: [],
          tocDepth: { min: 1, max: 6 }
        })
    })

    const router = await createTestRouter(['/'])

    const i18n = createTestI18n()

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
    await flushPromises()
    // -> The block scan runs inside the route watcher's own `nextTick`, one tick behind `pageLoad`
    //    resolving -- a second flush is what lets that nested callback actually run
    await flushPromises()

    const loadedTags = loadBlocksSpy.mock.calls.flatMap((call) =>
      call[0].map((entry) => (typeof entry === 'string' ? entry : entry.tag))
    )
    expect(loadedTags).toContain('block-diagram')

    wrapper.unmount()
  })
})

/**
 * OpenProject #1734: the block scan below used to call `commonStore.loadBlocks()` once PER
 * undefined element, rather than once for the whole page. `loadBlocks()`'s own `!blocksLoaded
 * .includes(...)` filter only screens out a tag that has ALREADY finished loading, so N concurrent
 * calls for the same not-yet-loaded tag all pass it -- a page with several elements of the same tag
 * (a `block-tabs` used three times, say) fired three identical `loadBlocks()` calls instead of one,
 * making `blocksLoaded` misleading to anyone debugging block loading. Collapsed into a single call
 * with one Map entry per tag, mirroring `EditorMarkdown.vue`'s own `pendingBlocks` Map.
 */
describe('Index.vue: collapses the block scan into one loadBlocks() call (OpenProject #1734)', () => {
  it('produces exactly one loadBlocks() call carrying one entry per tag, for a page with several elements sharing a tag', async () => {
    setActivePinia(createPinia())

    const commonStore = useCommonStore()
    const loadBlocksSpy = vi.spyOn(commonStore, 'loadBlocks').mockResolvedValue(undefined)

    const siteStore = useSiteStore()
    siteStore.blocksIndex = {
      tabs: { id: null, isCustom: false },
      alert: { id: null, isCustom: false }
    }

    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          id: 'page-1',
          path: 'tabbed-page',
          editor: 'markdown',
          render:
            '<block-tabs>One</block-tabs>' +
            '<block-tabs>Two</block-tabs>' +
            '<block-tabs>Three</block-tabs>' +
            '<block-alert>Note</block-alert>',
          relations: [],
          tocDepth: { min: 1, max: 6 }
        })
    })

    const router = await createTestRouter(['/'])

    const i18n = createTestI18n()

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
    await flushPromises()
    // -> The block scan runs inside the route watcher's own `nextTick`, one tick behind `pageLoad`
    //    resolving -- a second flush is what lets that nested callback actually run
    await flushPromises()

    expect(loadBlocksSpy).toHaveBeenCalledTimes(1)
    const [entries] = loadBlocksSpy.mock.calls[0]
    const tags = entries.map((entry) => (typeof entry === 'string' ? entry : entry.tag))
    expect(tags).toEqual(['block-tabs', 'block-alert'])

    wrapper.unmount()
  })
})

/**
 * OpenProject #1729: a `block-*` tag absent from `siteStore.blocksIndex` used to fall back to the
 * bare tag, which `loadBlocks()` resolves to the flat, unauthenticated `/_blocks/<tag>.js` URL --
 * so a block a site administrator had switched off still loaded for a reader whose stored page HTML
 * still embedded it. `blockAllowances()`/`siteBlocksInfoFor` document that a disabled block must
 * never reach a reader's browser, neither its config nor a URL to fetch its code from.
 *
 * `block-tab` is the one legitimate absent-from-`blocksIndex` case: a child block gets no row of
 * its own (`models/blocks.ts#syncSite`), so it never appears there even when its parent `block-tabs`
 * is enabled -- told apart from a disabled block by ancestry, the same way the server's own
 * `unwrapOrphanedChildBlocks` (`backend/models/rendering.ts`) does.
 */
describe('Index.vue: reader-view block scan skips a block absent from blocksIndex (OpenProject #1729)', () => {
  it('does not load a block-* tag absent from blocksIndex, but still loads a child block whose parent is present', async () => {
    setActivePinia(createPinia())

    const commonStore = useCommonStore()
    const loadBlocksSpy = vi.spyOn(commonStore, 'loadBlocks').mockResolvedValue(undefined)

    const siteStore = useSiteStore()
    // -> `tabs` (the parent) is enabled; `tab` (the child) never gets a row of its own, so it is
    //    never a key here even when its parent is. `widget` stands in for a block the site has
    //    switched off -- absent from the index the same way, but with no enabled ancestor to save it.
    siteStore.blocksIndex = { tabs: { id: null, isCustom: false } }

    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        Promise.resolve({
          id: 'page-1',
          path: 'tabs-page',
          editor: 'markdown',
          render:
            '<block-tabs><block-tab name="One">Content</block-tab></block-tabs>' +
            '<block-widget>disabled block markup left over in stored HTML</block-widget>',
          relations: [],
          tocDepth: { min: 1, max: 6 }
        })
    })

    const router = await createTestRouter(['/'])

    const i18n = createTestI18n()

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
    await flushPromises()
    // -> The block scan runs inside the route watcher's own `nextTick`, one tick behind `pageLoad`
    //    resolving -- a second flush is what lets that nested callback actually run
    await flushPromises()

    const loadedTags = loadBlocksSpy.mock.calls.flatMap((call) =>
      call[0].map((entry) => (typeof entry === 'string' ? entry : entry.tag))
    )
    expect(loadedTags).toContain('block-tabs')
    expect(loadedTags).toContain('block-tab')
    expect(loadedTags).not.toContain('block-widget')

    wrapper.unmount()
  })
})
