import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import Index from './Index.vue'
import { useCommonStore } from '@/stores/common'
import { useSiteStore } from '@/stores/site'
import { createTestI18n } from '../../test/i18n.js'
import { createTestRouter } from '../../test/router.js'

/*
 * `useScreen` calls `window.matchMedia` and the common store reads `localStorage` as it is
 * instantiated, both of which mounting a whole page view needs. Stubbed here rather than in the
 * shared `test/setup.js`, which would claim more about every other test than this one knows.
 * `localStorage` is a real but non-functional Node global in this runtime rather than simply
 * absent, so it has to be overwritten, not filled in when missing.
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
 * Torn down after every test rather than left for the next mount: the next `setActivePinia`
 * replaces the instance while this one's stores are still live, and an un-unmounted component keeps
 * watchers running against them -- surfacing as an unhandled rejection on a disposed reactive scope
 * in whatever test runs next.
 */
let activeWrapper = null

afterEach(() => {
  activeWrapper?.unmount()
  activeWrapper = null
})

/*
 * A block is a Lit element that only draws once its script has been imported and the tag upgrades,
 * so a page loaded straight from storage has to be scanned for undefined block tags just as the
 * live editor preview is. Upstream's requarks/wiki#1839 ("Mermaid renders in the live edit preview
 * but not on the saved/reloaded page") is what a missing read-path scan looks like.
 */
describe('Index.vue: read-path block loading for a directly-loaded/reloaded page (OpenProject #829 item 1)', () => {
  it('loads a block found only in the stored page render, never having gone through the live editor preview', async () => {
    setActivePinia(createPinia())

    const commonStore = useCommonStore()
    const loadBlocksSpy = vi.spyOn(commonStore, 'loadBlocks').mockResolvedValue(undefined)

    // -> The scan resolves a tag off `siteStore.blocksIndex` rather than over the network, and
    //    skips any tag absent from it, so the block has to be present here to load at all. Set
    //    directly rather than through `applySiteInfo`: nothing here needs a full site-info payload
    const siteStore = useSiteStore()
    siteStore.blocksIndex = { diagram: { id: null, isCustom: false } }

    // -> The shape `rendering.postProcess` stores -- the block element wrapping its fenced mermaid
    //    source -- exactly as a reload's GET hands it back
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
          PageComments: true,
          PageCommentsEmbed: true
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
 * One call per page, one entry per tag: `loadBlocks()`'s own filter only screens out a tag that has
 * ALREADY finished loading, so a per-element scan fires N concurrent calls for the same pending tag
 * and leaves `blocksLoaded` misleading to anyone debugging block loading.
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
          PageComments: true,
          PageCommentsEmbed: true
        }
      }
    })
    await flushPromises()
    await flushPromises()

    expect(loadBlocksSpy).toHaveBeenCalledTimes(1)
    const [entries] = loadBlocksSpy.mock.calls[0]
    const tags = entries.map((entry) => (typeof entry === 'string' ? entry : entry.tag))
    expect(tags).toEqual(['block-tabs', 'block-alert'])

    wrapper.unmount()
  })
})

/**
 * A block a site administrator switched off must never reach a reader's browser, not even as a URL
 * to fetch its code from -- and stored page HTML goes on embedding it long after it is disabled.
 *
 * A child block is the one legitimate absent-from-`blocksIndex` case: it gets no row of its own, so
 * it is missing even when its parent is enabled, and is told apart from a disabled block by
 * ancestry (the same test the server's own `unwrapOrphanedChildBlocks` applies).
 */
describe('Index.vue: reader-view block scan skips a block absent from blocksIndex (OpenProject #1729)', () => {
  it('does not load a block-* tag absent from blocksIndex, but still loads a child block whose parent is present', async () => {
    setActivePinia(createPinia())

    const commonStore = useCommonStore()
    const loadBlocksSpy = vi.spyOn(commonStore, 'loadBlocks').mockResolvedValue(undefined)

    const siteStore = useSiteStore()
    // -> `tab` is absent because a child block never gets a row of its own; `widget` is absent
    //    because the site switched it off -- alike here except for the enabled ancestor
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
          PageComments: true,
          PageCommentsEmbed: true
        }
      }
    })
    await flushPromises()
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
