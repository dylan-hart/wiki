import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createI18n } from 'vue-i18n'

import Graph from './Graph.vue'
import { useSiteStore } from '@/stores/site'

function createTestI18n() {
  return createI18n({ legacy: false, locale: 'en', messages: { en: {} } })
}

const ZERO_TOTAL_PAGEVIEW_WINDOW = { browser: 0, api: 0, mcp: 0, all: 0 }
const ZERO_PAGEVIEW_WINDOW = {
  browser: 0,
  api: 0,
  mcp: 0,
  all: 0,
  total: ZERO_TOTAL_PAGEVIEW_WINDOW
}
const ZERO_PAGEVIEWS = {
  last30d: ZERO_PAGEVIEW_WINDOW,
  last6mo: ZERO_PAGEVIEW_WINDOW,
  last2yr: ZERO_PAGEVIEW_WINDOW
}

const FIXTURE_GRAPH = {
  nodes: [
    {
      path: 'a',
      locale: 'en',
      title: 'A',
      icon: null,
      tags: [],
      folder: '',
      // -> `total` (OpenProject #1269) is deliberately NOT double the unique figures by the same
      //    factor everywhere -- distinct values from the unique ones make it obvious a test that
      //    reads `total` is actually reading `total`, not silently passing off the unique fixture.
      contributors: { editor: 3, mcp: 1, all: 4, total: { editor: 6, mcp: 3, all: 9 } },
      pageviews: {
        last30d: {
          browser: 10,
          api: 2,
          mcp: 0,
          all: 12,
          total: { browser: 25, api: 5, mcp: 0, all: 30 }
        },
        last6mo: {
          browser: 40,
          api: 5,
          mcp: 1,
          all: 46,
          total: { browser: 90, api: 12, mcp: 3, all: 105 }
        },
        last2yr: {
          browser: 90,
          api: 8,
          mcp: 2,
          all: 100,
          total: { browser: 200, api: 20, mcp: 6, all: 226 }
        }
      }
    },
    {
      path: 'b',
      locale: 'en',
      title: 'B',
      icon: null,
      tags: [],
      folder: '',
      contributors: { editor: 0, mcp: 0, all: 0, total: { editor: 0, mcp: 0, all: 0 } },
      pageviews: ZERO_PAGEVIEWS
    }
  ],
  edges: [{ source: 'a', target: 'b', type: 'link' }]
}

/** OpenProject #1686's fallback-list tests need a real-to-real edge to assert against -- under
 *  every current `edgeMode` two nodes are only ever DIRECTLY connected when one's path is
 *  literally the other's parent path (every other case is mediated by a synthetic folder/tag/
 *  classification hub, per `graphFilters.js#buildPathHierarchyEdges` reusing a real page as its
 *  own folder node rather than synthesizing a duplicate). `docs` is deliberately real (not just
 *  `docs/child`), so `buildPathHierarchyEdges` wires `docs -> docs/child` directly instead of
 *  through a synthetic `docs` marker. */
const NESTED_FIXTURE_GRAPH = {
  nodes: [
    { path: 'docs', locale: 'en', title: 'Docs', icon: null, tags: [], folder: '' },
    { path: 'docs/child', locale: 'en', title: 'Child', icon: null, tags: [], folder: 'docs' }
  ],
  edges: []
}

/** Options for `API_CLIENT.get('system/pageviews')` -- defaults to tracking enabled so the
 *  'visits' sizing option is available in the default `mountGraph()` fixture; a test asserting the
 *  disabled case passes `{ pageviewsEnabled: false }`. `graph` defaults to `FIXTURE_GRAPH` --
 *  passing `NESTED_FIXTURE_GRAPH` is how the #1686 fallback-list tests get a real-to-real edge. */
async function mountGraph({ pageviewsEnabled = true, graph = FIXTURE_GRAPH } = {}) {
  setActivePinia(createPinia())
  const siteStore = useSiteStore()
  siteStore.id = 'site-1'

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }]
  })
  router.push('/')
  await router.isReady()

  API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(graph) })
  API_CLIENT.get.mockReturnValueOnce({
    json: () => Promise.resolve({ isEnabled: pageviewsEnabled })
  })

  const wrapper = mount(Graph, { global: { plugins: [router, createTestI18n()] } })
  await flushPromises()
  return wrapper
}

/*
 * Asserting actual pixel output is out of practical reach for a unit test -- a real
 * testing-strategy limitation, not an oversight (per the design spec's own admission). This suite
 * checks the simulation initializes and the canvas element exists, without throwing.
 */
describe('Graph.vue (OpenProject #891)', () => {
  it('mounts, fetches the graph, and renders a canvas with no console errors', async () => {
    const wrapper = await mountGraph()

    expect(wrapper.find('canvas').exists()).toBe(true)
    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/graph')
  })

  it('paths mode (the default edgeMode) adds synthetic folder/root nodes to the visible set', async () => {
    const wrapper = await mountGraph()

    expect(wrapper.vm.edgeMode).toBe('paths')
    expect(wrapper.vm.nodes.length).toBeGreaterThan(FIXTURE_GRAPH.nodes.length)
    expect(wrapper.vm.nodes.some((node) => node.synthetic === true)).toBe(true)
  })

  it('switching edgeMode does not throw', async () => {
    const wrapper = await mountGraph()

    wrapper.vm.edgeMode = 'tags'
    await flushPromises()

    expect(wrapper.find('canvas').exists()).toBe(true)
  })

  it('switching edgeMode to classification (OpenProject #1217) does not throw', async () => {
    const wrapper = await mountGraph()

    wrapper.vm.edgeMode = 'classification'
    await flushPromises()

    expect(wrapper.find('canvas').exists()).toBe(true)
  })

  it('switching groupBy to classification (OpenProject #1217) does not throw', async () => {
    const wrapper = await mountGraph()

    wrapper.vm.groupBy = 'classification'
    await flushPromises()

    expect(wrapper.find('canvas').exists()).toBe(true)
  })

  it('defaults to edits sizing (no "uniform" mode any more), scaling by contributor count', async () => {
    const wrapper = await mountGraph()

    expect(wrapper.vm.sizeBy).toBe('edits')
    expect(wrapper.vm.sizeCountMode).toBe('unique')
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    expect(wrapper.vm.radiusFor(nodeA)).toBeGreaterThan(wrapper.vm.radiusFor(nodeB))
  })

  it('edits sizing scales a node bigger with more contributors than one with fewer', async () => {
    const wrapper = await mountGraph()
    wrapper.vm.sizeBy = 'edits'
    await flushPromises()

    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    expect(wrapper.vm.radiusFor(nodeA)).toBeGreaterThan(wrapper.vm.radiusFor(nodeB))
    expect(wrapper.find('canvas').exists()).toBe(true)
  })

  it('contributorCountFor reads the pre-unioned "all" count only when both types are checked', async () => {
    const wrapper = await mountGraph()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')

    expect(wrapper.vm.contributorTypes).toEqual(['editor', 'mcp'])
    expect(wrapper.vm.contributorCountFor(nodeA)).toBe(4)

    wrapper.vm.contributorTypes = ['editor']
    expect(wrapper.vm.contributorCountFor(nodeA)).toBe(3)

    wrapper.vm.contributorTypes = ['mcp']
    expect(wrapper.vm.contributorCountFor(nodeA)).toBe(1)

    wrapper.vm.contributorTypes = []
    expect(wrapper.vm.contributorCountFor(nodeA)).toBe(0)
  })

  it('shows a client-type filter in edits mode (the default) -- and still one in visits mode', async () => {
    const wrapper = await mountGraph()

    // -> 'edits' is the default sizing mode now that 'uniform' is gone, so its own client-type
    //    filter (contributorTypes) is already visible on mount, unlike before #1270. Switching to
    //    'visits' swaps in that mode's own client-type filter (pageviewClientTypes) -- both render
    //    through the same `GraphClientTypeFilter` component/class, so the filter itself never
    //    disappears any more; only which one is showing changes.
    expect(wrapper.find('.graph-client-type-filter').exists()).toBe(true)
    expect(wrapper.text()).toContain('Count edits by')

    wrapper.vm.sizeBy = 'visits'
    await flushPromises()

    expect(wrapper.find('.graph-client-type-filter').exists()).toBe(true)
    expect(wrapper.text()).toContain('Count visits by')
  })

  it('visits sizing scales a node bigger with more pageviews than one with fewer', async () => {
    const wrapper = await mountGraph()
    wrapper.vm.sizeBy = 'visits'
    await flushPromises()

    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    expect(wrapper.vm.radiusFor(nodeA)).toBeGreaterThan(wrapper.vm.radiusFor(nodeB))
    expect(wrapper.find('canvas').exists()).toBe(true)
  })

  it('pageviewCountFor sums checked buckets within the selected window', async () => {
    const wrapper = await mountGraph()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')

    expect(wrapper.vm.pageviewsWindow).toBe('last30d')
    expect(wrapper.vm.pageviewClientTypes).toEqual(['browser', 'api', 'mcp'])
    expect(wrapper.vm.pageviewCountFor(nodeA)).toBe(12)

    wrapper.vm.pageviewClientTypes = ['browser']
    expect(wrapper.vm.pageviewCountFor(nodeA)).toBe(10)

    wrapper.vm.pageviewClientTypes = []
    expect(wrapper.vm.pageviewCountFor(nodeA)).toBe(0)

    wrapper.vm.pageviewClientTypes = ['browser', 'api', 'mcp']
    wrapper.vm.pageviewsWindow = 'last2yr'
    expect(wrapper.vm.pageviewCountFor(nodeA)).toBe(100)
  })

  it('shows the window selector only in visits mode', async () => {
    const wrapper = await mountGraph()

    // -> The window selector ('Over: 30 days / 6 months / 2 years') is 'visits'-only, unlike the
    //    client-type filter, which the default 'edits' mode already shows -- see the previous test.
    expect(wrapper.text()).not.toContain('30 days')

    wrapper.vm.sizeBy = 'visits'
    await flushPromises()

    expect(wrapper.find('.graph-client-type-filter').exists()).toBe(true)
    expect(wrapper.text()).toContain('30 days')
  })

  it('offers "Edits" and "Visits" sizing labels, with no "Uniform" option, when tracking is enabled', async () => {
    const wrapper = await mountGraph({ pageviewsEnabled: true })

    expect(wrapper.vm.sizeByOptions).toEqual([
      { label: 'Edits', value: 'edits' },
      { label: 'Visits', value: 'visits' }
    ])
  })

  it('hides "Visits" sizing entirely when tracking is disabled, leaving only "Edits"', async () => {
    const wrapper = await mountGraph({ pageviewsEnabled: false })

    expect(wrapper.vm.sizeByOptions).toEqual([{ label: 'Edits', value: 'edits' }])
  })

  it('falls back to edits sizing (no "uniform" mode any more) if tracking turns off while visits mode is active', async () => {
    const wrapper = await mountGraph({ pageviewsEnabled: true })
    wrapper.vm.sizeBy = 'visits'
    await flushPromises()

    wrapper.vm.pageviewsTrackingEnabled = false
    await flushPromises()

    expect(wrapper.vm.sizeBy).toBe('edits')
  })

  it('renders the Unique/Total "Count" toggle, defaulting to Unique', async () => {
    const wrapper = await mountGraph()

    expect(wrapper.text()).toContain('Unique')
    expect(wrapper.text()).toContain('Total')
    expect(wrapper.vm.sizeCountMode).toBe('unique')
  })

  it('sizeCountMode toggle switches contributorCountFor between the unique and total fields', async () => {
    const wrapper = await mountGraph()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')

    expect(wrapper.vm.contributorCountFor(nodeA)).toBe(4)

    wrapper.vm.sizeCountMode = 'total'
    expect(wrapper.vm.contributorCountFor(nodeA)).toBe(9)
  })

  it('sizeCountMode toggle switches pageviewCountFor between the unique and total fields', async () => {
    const wrapper = await mountGraph()
    wrapper.vm.sizeBy = 'visits'
    await flushPromises()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')

    expect(wrapper.vm.pageviewCountFor(nodeA)).toBe(12)

    wrapper.vm.sizeCountMode = 'total'
    expect(wrapper.vm.pageviewCountFor(nodeA)).toBe(30)
  })

  it('sizeCountMode toggle scales a node bigger in total mode than in unique mode', async () => {
    const wrapper = await mountGraph()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')

    const uniqueRadius = wrapper.vm.radiusFor(nodeA)
    wrapper.vm.sizeCountMode = 'total'
    const totalRadius = wrapper.vm.radiusFor(nodeA)

    expect(totalRadius).toBeGreaterThan(uniqueRadius)
  })

  it('drawLabels hides labels below the visibility threshold, shows them at/above it (OpenProject #1287/#1288)', async () => {
    const wrapper = await mountGraph()

    // -> `1.2` sits between the old `1.5` threshold and the new, lower one -- proving labels now
    //    persist at a zoom level that used to hide them.
    wrapper.vm.zoomTransform = { k: 1.05, x: 0, y: 0 }
    wrapper.vm.drawLabels()
    expect(wrapper.vm.ctx.fillText).not.toHaveBeenCalled()

    wrapper.vm.ctx.fillText.mockClear()
    wrapper.vm.zoomTransform = { k: 1.2, x: 0, y: 0 }
    wrapper.vm.drawLabels()
    expect(wrapper.vm.ctx.fillText).toHaveBeenCalled()
  })

  it('drawLabels caps the effective on-screen font size at high zoom (OpenProject #1287/#1288)', async () => {
    const wrapper = await mountGraph()

    wrapper.vm.zoomTransform = { k: 2, x: 0, y: 0 }
    wrapper.vm.drawLabels()
    const [belowCapPx] = wrapper.vm.ctx.font.match(/[\d.]+/)
    // -> Below the cap (2 * 10px = 20px effective), the base font size is unchanged.
    expect(Number(belowCapPx)).toBe(10)

    wrapper.vm.zoomTransform = { k: 8, x: 0, y: 0 }
    wrapper.vm.drawLabels()
    const [atMaxZoomPx] = wrapper.vm.ctx.font.match(/[\d.]+/)
    // -> At max zoom, the drawn font is scaled down so `fontPx * k` stops growing past the cap.
    expect(Number(atMaxZoomPx)).toBeLessThan(10)
    expect(Number(atMaxZoomPx) * 8).toBeLessThanOrEqual(24)
  })

  it('recovers from a fetch failure without throwing', async () => {
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }]
    })
    router.push('/')
    await router.isReady()
    API_CLIENT.get.mockImplementationOnce(() => {
      throw new Error('network')
    })

    const wrapper = mount(Graph, { global: { plugins: [router, createTestI18n()] } })
    await flushPromises()

    expect(wrapper.find('canvas').exists()).toBe(true)
  })

  describe('keyboard/screen-reader fallback list (OpenProject #1686)', () => {
    it("renders one focusable <a> per real node, pointing at that node's page path", async () => {
      const wrapper = await mountGraph()

      // -> Default `edgeMode` ('paths') synthesizes a root node for 'a'/'b' (both top-level
      //    paths); the fallback list gets no top-level entry for it -- only 'a' and 'b' do.
      const links = wrapper.findAll('.graph-view-fallback > li > a')
      expect(links).toHaveLength(2)
      expect(links.map((link) => link.attributes('href')).sort()).toEqual(['/a', '/b'])
    })

    it('is visually hidden (sr-only) while its links stay real, focusable <a> elements', async () => {
      const wrapper = await mountGraph()

      const list = wrapper.find('.graph-view-fallback')
      expect(list.classes()).toContain('sr-only')
      expect(list.element.tagName).toBe('UL')

      const link = wrapper.find('.graph-view-fallback a')
      expect(link.element.tagName).toBe('A')
      // -> No explicit tabindex means the native, keyboard-reachable default for an `<a href>`.
      expect(link.attributes('tabindex')).toBeUndefined()
    })

    it("lists each node's direct links: a real neighbor as an <a>, a synthetic one as plain text", async () => {
      const wrapper = await mountGraph({ graph: NESTED_FIXTURE_GRAPH })

      // -> Each `<li>`'s own top-level `<a>` always precedes its nested `<ul>` in document order,
      //    so a plain `find('a')` (happy-dom doesn't support a leading `> ` combinator scoped to
      //    an element) resolves to that entry's own link, not one of its nested neighbor links.
      const items = wrapper.findAll('.graph-view-fallback > li')
      const docsItem = items.find((item) => item.find('a').attributes('href') === '/docs')
      const childItem = items.find((item) => item.find('a').attributes('href') === '/docs/child')

      // -> 'docs' connects to the real 'docs/child' (a link) and the synthetic root node
      //    synthesized as 'docs' has no parent segment of its own (plain text, no <a>).
      expect(docsItem.find('ul a').attributes('href')).toBe('/docs/child')
      expect(docsItem.find('ul').text()).toContain('(root)')
      expect(docsItem.findAll('ul a')).toHaveLength(1)

      // -> 'docs/child' connects only to the real 'docs' node.
      expect(childItem.findAll('ul a')).toHaveLength(1)
      expect(childItem.find('ul a').attributes('href')).toBe('/docs')
    })

    it("clicking a fallback link navigates to that node's page (Enter activates an <a> the same way)", async () => {
      const wrapper = await mountGraph()

      const link = wrapper.find('.graph-view-fallback a[href="/a"]')
      expect(link.exists()).toBe(true)

      await link.trigger('click')
      await flushPromises()

      expect(wrapper.vm.$router.currentRoute.value.fullPath).toBe('/a')
    })

    it('omits a top-level entry for a synthetic node, since it has no real page to link to', async () => {
      const wrapper = await mountGraph()

      expect(wrapper.vm.fallbackNodes.some((entry) => entry.node.synthetic)).toBe(false)
    })
  })
})
