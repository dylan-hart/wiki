import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createI18n } from 'vue-i18n'
import { isReactive } from 'vue'

import Graph from './Graph.vue'
// -> `drawLabels` moved to `graphDraw.js` as a pure function over the canvas context (VIEW-F13.7);
//    these tests call it directly rather than through a page-local wrapper that nothing else needs.
import { drawLabels, LABEL_GAP } from './graphDraw.js'
import { useSiteStore } from '@/stores/site'

/** Mirrors `backend/locales/en.json`'s `graph.*` namespace (OpenProject #1690) -- kept here rather
 *  than imported so this suite doesn't depend on the real locale file's exact key set, only on the
 *  component asking `t()` for these specific keys with these specific meanings. The two `tooltip.*`
 *  entries use vue-i18n's pipe-delimited plural syntax (`singular | plural`), same as the real file. */
const GRAPH_MESSAGES = {
  'graph.accessibleName.link': '{count} link | {count} links',
  'graph.accessibleName.page': '{count} page | {count} pages',
  'graph.accessibleName.summary': 'Knowledge graph: {pages}, {links}, grouped by {groupBy}',
  'graph.filters.tags': 'Tags',
  'graph.filters.folderDepth': 'Folder Depth',
  'graph.filters.locale': 'Locale',
  'graph.filters.clear': 'Clear filters',
  'graph.controls.groupByLabel': 'Group by',
  'graph.controls.groupByFolder': 'Folder',
  'graph.controls.groupByTag': 'Tag',
  'graph.controls.groupByClassification': 'Classification',
  'graph.controls.connectByLabel': 'Connect by',
  'graph.controls.connectByPaths': 'Paths',
  'graph.controls.connectByTags': 'Tags',
  'graph.controls.connectByClassification': 'Classification',
  'graph.controls.sizeByLabel': 'Size by',
  'graph.controls.sizeByEdits': 'Edits',
  'graph.controls.sizeByVisits': 'Visits',
  'graph.controls.countLabel': 'Count',
  'graph.controls.countAriaLabel': 'Unique or total',
  'graph.controls.countUnique': 'Unique',
  'graph.controls.countTotal': 'Total',
  'graph.controls.editsByLabel': 'Count edits by',
  'graph.controls.editsByEditor': 'Editor',
  'graph.controls.editsByMcp': 'MCP',
  'graph.controls.overLabel': 'Over',
  'graph.controls.overAriaLabel': 'Time window',
  'graph.controls.over30Days': '30 days',
  'graph.controls.over6Months': '6 months',
  'graph.controls.over2Years': '2 years',
  'graph.controls.visitsByLabel': 'Count visits by',
  'graph.controls.visitsByBrowser': 'Browser',
  'graph.controls.visitsByApi': 'API',
  'graph.controls.visitsByMcp': 'MCP',
  'graph.tooltip.contributors': '{count} contributor | {count} contributors',
  'graph.tooltip.edits': '{count} edit | {count} edits',
  'graph.tooltip.uniqueVisitors': '{count} unique visitor | {count} unique visitors',
  'graph.tooltip.visits': '{count} visit | {count} visits'
}

function createTestI18n(messageOverrides = {}) {
  return createI18n({
    legacy: false,
    locale: 'en',
    messages: { en: { ...GRAPH_MESSAGES, ...messageOverrides } }
  })
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
      id: 'en:a',
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
      id: 'en:b',
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
  // -> Composite `${locale}:${path}` ids (OpenProject #1621), matching the real
  //    `backend/api/graph.ts#assembleGraph` response shape -- see that module's own doc comment.
  edges: [{ source: 'en:a', target: 'en:b', type: 'link' }]
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

/** OpenProject #1866's response shape as `FIXTURE_GRAPH` extended with `truncated`/`totalNodes` --
 *  `truncated: true` with a `totalNodes` well above the two returned nodes, so the "N of totalNodes"
 *  notice text (OpenProject #1875) is unambiguous either way it might be phrased. */
const FIXTURE_GRAPH_TRUNCATED = {
  ...FIXTURE_GRAPH,
  truncated: true,
  totalNodes: 5000
}

/** Options for `API_CLIENT.get('system/pageviews')` -- defaults to tracking enabled so the
 *  'visits' sizing option is available in the default `mountGraph()` fixture; a test asserting the
 *  disabled case passes `{ pageviewsEnabled: false }`. `graph` defaults to `FIXTURE_GRAPH` (a
 *  single-locale graph); a test exercising a different node/edge shape -- the locale-duplicate case
 *  (OpenProject #1629), the locale-filter tests' multi-locale graph (OpenProject #2294), or the
 *  #1686 fallback-list tests' `NESTED_FIXTURE_GRAPH` (for a real-to-real edge) -- passes its own.
 *  `messageOverrides` is forwarded to `createTestI18n()` for a test asserting one specific
 *  resolved string. */
async function mountGraph({
  pageviewsEnabled = true,
  graph = FIXTURE_GRAPH,
  messageOverrides = {}
} = {}) {
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

  const wrapper = mount(Graph, {
    global: { plugins: [router, createTestI18n(messageOverrides)] }
  })
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
    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/graph', {
      searchParams: { sizing: 'edits' }
    })
  })

  // -> OpenProject #1863: the fetch's `sizing` param tracks whichever "Size by" mode is active at
  //    load time -- not a fixed 'edits', which the test above (mounting at the default mode) can't
  //    tell apart from a hardcoded value.
  it('sends the currently-active sizeBy mode as the sizing param on (re)load', async () => {
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }]
    })
    router.push('/')
    await router.isReady()

    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(FIXTURE_GRAPH) })
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ isEnabled: true }) })
    const wrapper = mount(Graph, { global: { plugins: [router, createTestI18n()] } })
    await flushPromises()

    wrapper.vm.sizeBy = 'visits'
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(FIXTURE_GRAPH) })
    await wrapper.vm.loadGraph()

    expect(API_CLIENT.get).toHaveBeenLastCalledWith('sites/site-1/graph', {
      searchParams: { sizing: 'visits' }
    })
  })

  // -> OpenProject #1621/#1629: `forceLink().id()` used to resolve on the bare `path`, so an
  //    `en`/`fr` pair sharing a path collapsed to a single d3-force node with no error.
  it('same-path translations render as two distinct, separately-keyed nodes', async () => {
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }]
    })
    router.push('/')
    await router.isReady()

    const sharedPathGraph = {
      nodes: [
        {
          id: 'en:docs/intro',
          path: 'docs/intro',
          locale: 'en',
          title: 'Intro',
          icon: null,
          tags: [],
          folder: 'docs',
          contributors: { editor: 0, mcp: 0, all: 0, total: { editor: 0, mcp: 0, all: 0 } },
          pageviews: ZERO_PAGEVIEWS
        },
        {
          id: 'fr:docs/intro',
          path: 'docs/intro',
          locale: 'fr',
          title: 'Introduction',
          icon: null,
          tags: [],
          folder: 'docs',
          contributors: { editor: 0, mcp: 0, all: 0, total: { editor: 0, mcp: 0, all: 0 } },
          pageviews: ZERO_PAGEVIEWS
        }
      ],
      edges: []
    }
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(sharedPathGraph) })
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ isEnabled: true }) })

    const wrapper = mount(Graph, { global: { plugins: [router, createTestI18n()] } })
    await flushPromises()

    const realNodes = wrapper.vm.nodes.filter((node) => !node.synthetic)
    expect(realNodes).toHaveLength(2)
    expect(realNodes.map((node) => node.id).sort()).toEqual(['en:docs/intro', 'fr:docs/intro'])
    // -> Both nodes share the same `path` (by design -- translations are same-path), but remain two
    //    separate objects in the simulation's node list rather than one collapsing onto the other.
    expect(realNodes.every((node) => node.path === 'docs/intro')).toBe(true)
    expect(realNodes[0]).not.toBe(realNodes[1])
  })

  it('paths mode (the default edgeMode) adds synthetic folder/root nodes to the visible set', async () => {
    const wrapper = await mountGraph()

    expect(wrapper.vm.edgeMode).toBe('paths')
    expect(wrapper.vm.nodes.length).toBeGreaterThan(FIXTURE_GRAPH.nodes.length)
    expect(wrapper.vm.nodes.some((node) => node.synthetic === true)).toBe(true)
  })

  it('keys the force layout on the composite locale:path id, giving same-path translations distinct simulation nodes and their own edges (OpenProject #1629)', async () => {
    const enIntro = {
      path: 'intro',
      locale: 'en',
      title: 'Intro (EN)',
      icon: null,
      tags: [],
      folder: '',
      contributors: { editor: 0, mcp: 0, all: 0, total: { editor: 0, mcp: 0, all: 0 } },
      pageviews: ZERO_PAGEVIEWS
    }
    const frIntro = { ...enIntro, locale: 'fr', title: 'Intro (FR)' }

    // -> The default 'paths' edgeMode and the default (null) locale filter are what actually
    //    exercised the pre-fix bug in production -- both translations visible together, chained
    //    into the path-hierarchy simulation by `startSimulation()`'s `forceLink().id()` accessor.
    const wrapper = await mountGraph({ graph: { nodes: [enIntro, frIntro], edges: [] } })

    const simNodes = wrapper.vm.nodes.filter((n) => n.path === 'intro')
    expect(simNodes).toHaveLength(2)
    expect(simNodes[0]).not.toBe(simNodes[1])

    // -> d3-force's link force resolves each edge's `source`/`target` to the actual node object it
    //    matched by id the moment it's attached to the simulation -- before the pre-fix accessor
    //    (`.id((d) => d.path)`), both translations' leaf edges would have resolved `target` to
    //    whichever one `nodeById` kept last, i.e. the exact same object twice.
    const introLinks = wrapper.vm.simulation
      .force('link')
      .links()
      .filter((link) => link.target.path === 'intro')
    expect(introLinks).toHaveLength(2)
    expect(introLinks[0].target).not.toBe(introLinks[1].target)
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

  // -> OpenProject #2293: the tooltip noun must follow `sizeCountMode` as well as `sizeBy` --
  //    'total' reads raw, non-distinct row counts (an edit/visit tally) while 'unique' reads
  //    distinct-identity counts (a contributor/visitor tally), so two of the four combinations
  //    need a noun that differs from the other two sharing the same `sizeBy`.
  describe('hover tooltip noun (OpenProject #2293)', () => {
    it('names edits + unique sizing "contributor(s)"', async () => {
      const wrapper = await mountGraph()
      const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
      wrapper.vm.sizeBy = 'edits'
      wrapper.vm.sizeCountMode = 'unique'
      wrapper.vm.hoveredNode = nodeA
      await flushPromises()

      expect(wrapper.find('.graph-view-tooltip').text()).toContain('4 contributors')
    })

    it('names edits + total sizing "edit(s)", not "contributor(s)"', async () => {
      const wrapper = await mountGraph()
      const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
      wrapper.vm.sizeBy = 'edits'
      wrapper.vm.sizeCountMode = 'total'
      wrapper.vm.hoveredNode = nodeA
      await flushPromises()

      const tooltipText = wrapper.find('.graph-view-tooltip').text()
      expect(tooltipText).toContain('9 edits')
      expect(tooltipText).not.toContain('contributor')
    })

    it('names visits + unique sizing "unique visitor(s)", not "visit(s)"', async () => {
      const wrapper = await mountGraph()
      const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
      wrapper.vm.sizeBy = 'visits'
      wrapper.vm.sizeCountMode = 'unique'
      wrapper.vm.hoveredNode = nodeA
      await flushPromises()

      const tooltipText = wrapper.find('.graph-view-tooltip').text()
      expect(tooltipText).toContain('12 unique visitors')
      expect(tooltipText).not.toMatch(/\b12 visits\b/)
    })

    it('names visits + total sizing "visit(s)"', async () => {
      const wrapper = await mountGraph()
      const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
      wrapper.vm.sizeBy = 'visits'
      wrapper.vm.sizeCountMode = 'total'
      wrapper.vm.hoveredNode = nodeA
      await flushPromises()

      expect(wrapper.find('.graph-view-tooltip').text()).toContain('30 visits')
    })

    it('singularizes the noun for a count of exactly one', async () => {
      const wrapper = await mountGraph()
      const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
      wrapper.vm.sizeBy = 'edits'
      wrapper.vm.sizeCountMode = 'unique'
      wrapper.vm.contributorTypes = ['mcp']
      wrapper.vm.hoveredNode = nodeA
      await flushPromises()

      expect(wrapper.find('.graph-view-tooltip').text()).toContain('1 contributor')
      expect(wrapper.find('.graph-view-tooltip').text()).not.toContain('1 contributors')
    })
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

  it('drawLabels hides labels below the visibility threshold, shows them at/above it (OpenProject #2292, #1287/#1288)', async () => {
    const wrapper = await mountGraph()

    // -> `0.8` sits between the old `1.1` threshold and the new, lower one -- proving labels now
    //    persist at a zoom level that used to hide them. Mount's own initial draw (at the default
    //    `k = 1` zoom, itself above the new threshold) already logged fillText calls, so clear
    //    those before asserting on the below-threshold case.
    wrapper.vm.ctx.fillText.mockClear()
    drawLabels(wrapper.vm.ctx, wrapper.vm.nodes, wrapper.vm.radiusFor, 0.7)
    expect(wrapper.vm.ctx.fillText).not.toHaveBeenCalled()

    wrapper.vm.ctx.fillText.mockClear()
    drawLabels(wrapper.vm.ctx, wrapper.vm.nodes, wrapper.vm.radiusFor, 0.8)
    expect(wrapper.vm.ctx.fillText).toHaveBeenCalled()
  })

  it('drawLabels caps the effective on-screen font size at high zoom (OpenProject #1287/#1288)', async () => {
    const wrapper = await mountGraph()

    drawLabels(wrapper.vm.ctx, wrapper.vm.nodes, wrapper.vm.radiusFor, 2)
    const [belowCapPx] = wrapper.vm.ctx.font.match(/[\d.]+/)
    // -> Below the cap (2 * 10px = 20px effective), the base font size is unchanged.
    expect(Number(belowCapPx)).toBe(10)

    drawLabels(wrapper.vm.ctx, wrapper.vm.nodes, wrapper.vm.radiusFor, 8)
    const [atMaxZoomPx] = wrapper.vm.ctx.font.match(/[\d.]+/)
    // -> At max zoom, the drawn font is scaled down so `fontPx * k` stops growing past the cap.
    expect(Number(atMaxZoomPx)).toBeLessThan(10)
    expect(Number(atMaxZoomPx) * 8).toBeLessThanOrEqual(24)
  })

  it('paintGraph feeds the live zoom scale into drawLabels, not a fixed 1', async () => {
    const wrapper = await mountGraph()

    // -> The two drawLabels tests above call it directly with a scale. This one goes through
    //    `repaint()` -> `paintGraph({ transform: zoomTransform })`, which is the only caller in the
    //    app: `paintGraph` passes `transform?.k` down as the label scale, so a zoom below the
    //    visibility threshold must silence the label layer and a zoom past the font cap must shrink
    //    the drawn font. A `paintGraph` that hardcoded `1` would draw labels at 10px in both cases.
    wrapper.vm.zoomTransform = { k: 0.5, x: 0, y: 0 }
    wrapper.vm.ctx.fillText.mockClear()
    wrapper.vm.repaint()
    expect(wrapper.vm.ctx.fillText).not.toHaveBeenCalled()

    wrapper.vm.zoomTransform = { k: 4, x: 0, y: 0 }
    wrapper.vm.ctx.fillText.mockClear()
    wrapper.vm.repaint()
    expect(wrapper.vm.ctx.fillText).toHaveBeenCalled()
    const [drawnFontPx] = wrapper.vm.ctx.font.match(/[\d.]+/)
    expect(Number(drawnFontPx)).toBeLessThan(10)
    expect(Number(drawnFontPx) * 4).toBeLessThanOrEqual(24)
  })

  it('resolves every control-rail caption, aria-label and option label through t(), not a hardcoded English literal (OpenProject #1690)', async () => {
    const wrapper = await mountGraph({
      messageOverrides: {
        'graph.controls.groupByLabel': 'xx-groupBy',
        'graph.controls.groupByFolder': 'xx-folder',
        'graph.controls.groupByTag': 'xx-tag',
        'graph.controls.groupByClassification': 'xx-classification',
        'graph.controls.connectByLabel': 'xx-connectBy',
        'graph.controls.connectByPaths': 'xx-paths',
        'graph.controls.sizeByLabel': 'xx-sizeBy',
        'graph.controls.sizeByEdits': 'xx-edits',
        'graph.controls.countLabel': 'xx-count',
        'graph.controls.countAriaLabel': 'xx-uniqueOrTotal',
        'graph.controls.countUnique': 'xx-unique',
        'graph.controls.countTotal': 'xx-total',
        'graph.controls.editsByLabel': 'xx-editsBy',
        'graph.controls.editsByEditor': 'xx-editor',
        'graph.controls.editsByMcp': 'xx-mcp'
      }
    })

    // -> Every caption, translated option label and control group is visible on mount (the 'edits'
    //    sizing default), so all of these are checkable without any interaction.
    const text = wrapper.text()
    for (const translated of [
      'xx-groupBy',
      'xx-folder',
      'xx-tag',
      'xx-classification',
      'xx-connectBy',
      'xx-paths',
      'xx-sizeBy',
      'xx-edits',
      'xx-count',
      'xx-unique',
      'xx-total',
      'xx-editsBy',
      'xx-editor',
      'xx-mcp'
    ]) {
      expect(text).toContain(translated)
    }
    // -> None of the pre-#1690 English literals leak through -- proves these render via `t()`
    //    resolving the overridden messages above, not a string baked into the template.
    for (const literal of ['Group by', 'Connect by', 'Size by', 'Count edits by']) {
      expect(text).not.toContain(literal)
    }

    expect(wrapper.find('[aria-label="xx-groupBy"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="xx-connectBy"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="xx-sizeBy"]').exists()).toBe(true)
    // -> The 'Count' toggle's aria-label is its own key ('Unique or total'), distinct from its
    //    visible caption ('Count') -- both must resolve through `t()` independently.
    expect(wrapper.find('[aria-label="xx-uniqueOrTotal"]').exists()).toBe(true)
  })

  it('resolves the "visits"-only control rail (Over window, visits client-type filter) through t() (OpenProject #1690)', async () => {
    const wrapper = await mountGraph({
      messageOverrides: {
        'graph.controls.overLabel': 'xx-over',
        'graph.controls.overAriaLabel': 'xx-timeWindow',
        'graph.controls.over30Days': 'xx-30days',
        'graph.controls.visitsByLabel': 'xx-visitsBy',
        'graph.controls.visitsByBrowser': 'xx-browser',
        'graph.controls.visitsByApi': 'xx-api',
        'graph.controls.visitsByMcp': 'xx-mcp2'
      }
    })

    wrapper.vm.sizeBy = 'visits'
    await flushPromises()

    const text = wrapper.text()
    for (const translated of [
      'xx-over',
      'xx-30days',
      'xx-visitsBy',
      'xx-browser',
      'xx-api',
      'xx-mcp2'
    ]) {
      expect(text).toContain(translated)
    }
    expect(text).not.toContain('30 days')
    expect(text).not.toContain('Count visits by')
    expect(wrapper.find('[aria-label="xx-timeWindow"]').exists()).toBe(true)
  })

  it('renders the hover tooltip\'s contributor count through a real plural message, not an appended "s" (OpenProject #1690)', async () => {
    const wrapper = await mountGraph({
      messageOverrides: {
        // -> Deliberately not just an English 's' suffix -- proves the singular/plural split comes
        //    from vue-i18n's own plural-choice resolution (index 0 for count === 1, index 1
        //    otherwise), not from string concatenation baked into the component.
        'graph.tooltip.contributors': '{count} xx-one-contributor | {count} xx-many-contributors'
      }
    })
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')

    // -> nodeA's edits count is 4 (both contributor types checked, the default) -> plural form.
    wrapper.vm.hoveredNode = nodeA
    await flushPromises()
    expect(wrapper.text()).toContain('4 xx-many-contributors')
    expect(wrapper.text()).not.toContain('4 contributors')

    // -> Narrowing to just 'mcp' brings nodeA's count down to 1 -> the singular form, not the
    //    plural one -- the old `count === 1 ? '' : 's'` logic could only ever pick between an 's'
    //    suffix and none, never a genuinely different word/form the way a real plural rule can.
    wrapper.vm.contributorTypes = ['mcp']
    await flushPromises()
    expect(wrapper.text()).toContain('1 xx-one-contributor')
    expect(wrapper.text()).not.toContain('1 xx-many-contributors')

    // -> nodeB has zero contributors -> the plural form (English's plural rule treats 0 as plural,
    //    same as the pre-#1690 code's own `0 === 1 ? '' : 's'` -> "0 contributors" behavior).
    wrapper.vm.contributorTypes = ['editor', 'mcp']
    wrapper.vm.hoveredNode = nodeB
    await flushPromises()
    expect(wrapper.text()).toContain('0 xx-many-contributors')
  })

  it("renders the hover tooltip's visit count through a real plural message when sizing by visits (OpenProject #1690)", async () => {
    const wrapper = await mountGraph({
      messageOverrides: {
        // -> `sizeCountMode` defaults to 'unique' (OpenProject #2293), so the default visits
        //    tooltip resolves through `graph.tooltip.uniqueVisitors`, not `graph.tooltip.visits`
        //    (that key backs the 'total' count mode instead -- see the sibling 'total' test below).
        'graph.tooltip.uniqueVisitors': '{count} xx-one-visit | {count} xx-many-visits'
      }
    })
    wrapper.vm.sizeBy = 'visits'
    await flushPromises()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')

    // -> nodeA's last30d visit count (all client types, the default) is 12 -> plural form.
    wrapper.vm.hoveredNode = nodeA
    await flushPromises()
    expect(wrapper.text()).toContain('12 xx-many-visits')
    expect(wrapper.text()).not.toContain('12 visits')
  })

  it("renders the hover tooltip's visit count through the 'total' plural message when sizeCountMode is 'total' (OpenProject #2293)", async () => {
    const wrapper = await mountGraph({
      messageOverrides: {
        'graph.tooltip.visits': '{count} xx-one-total-visit | {count} xx-many-total-visits'
      }
    })
    wrapper.vm.sizeBy = 'visits'
    wrapper.vm.sizeCountMode = 'total'
    await flushPromises()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')

    // -> nodeA's last30d total (non-distinct) visit count is 30 -> plural form.
    wrapper.vm.hoveredNode = nodeA
    await flushPromises()
    expect(wrapper.text()).toContain('30 xx-many-total-visits')
  })

  it('gives the canvas role="img" and a computed accessible name reflecting node/link counts and grouping (OpenProject #1681)', async () => {
    const wrapper = await mountGraph()
    const canvas = wrapper.find('canvas')

    expect(canvas.attributes('role')).toBe('img')
    const label = canvas.attributes('aria-label')
    const realPageCount = wrapper.vm.nodes.filter((node) => !node.synthetic).length
    expect(realPageCount).toBe(FIXTURE_GRAPH.nodes.length)
    expect(label).toContain(`${realPageCount} page`)
    expect(label).toContain(`${wrapper.vm.edges.length} link`)
    expect(label).toContain('grouped by folder')
  })

  it('updates the accessible name when groupBy changes (OpenProject #1681)', async () => {
    const wrapper = await mountGraph()

    wrapper.vm.groupBy = 'classification'
    await flushPromises()

    expect(wrapper.find('canvas').attributes('aria-label')).toContain('grouped by classification')
  })

  it('resolves the canvas accessible name through graph.* i18n keys, not a hardcoded English literal (OpenProject #1690, #2359)', async () => {
    const wrapper = await mountGraph({
      messageOverrides: {
        'graph.accessibleName.page': '{count} xx-page | {count} xx-pages',
        'graph.accessibleName.link': '{count} xx-link | {count} xx-links',
        'graph.accessibleName.summary': 'xx-summary {pages} :: {links} :: {groupBy}'
      }
    })
    await flushPromises()

    const label = wrapper.find('canvas').attributes('aria-label')
    const realPageCount = wrapper.vm.nodes.filter((node) => !node.synthetic).length
    const linkCount = wrapper.vm.edges.length
    const pageWord = realPageCount === 1 ? 'xx-page' : 'xx-pages'
    const linkWord = linkCount === 1 ? 'xx-link' : 'xx-links'

    expect(label).toBe(
      `xx-summary ${realPageCount} ${pageWord} :: ${linkCount} ${linkWord} :: folder`
    )
  })

  it('keeps node/edge arrays and node objects out of deep reactivity (OpenProject #1837)', async () => {
    const wrapper = await mountGraph()

    // -> The arrays handed to `forceSimulation`/`forceLink` are `shallowRef`s, and every node/edge
    //    inside them is `markRaw()`'d as it's built -- neither the arrays nor their contents should
    //    ever become a Vue reactive proxy, since d3-force writes `x`/`y`/`vx`/`vy` on every node on
    //    every tick and nothing renders off these values reactively (canvas-only).
    expect(isReactive(wrapper.vm.nodes)).toBe(false)
    expect(isReactive(wrapper.vm.edges)).toBe(false)
    expect(isReactive(wrapper.vm.allNodes)).toBe(false)
    expect(isReactive(wrapper.vm.allEdges)).toBe(false)
    expect(wrapper.vm.nodes.length).toBeGreaterThan(0)
    for (const node of wrapper.vm.nodes) {
      expect(isReactive(node)).toBe(false)
    }
    for (const edge of wrapper.vm.edges) {
      expect(isReactive(edge)).toBe(false)
    }
  })

  it('relayout() rebuilds the quadtree and recomputes clusters; repaint() does neither (OpenProject #1837)', async () => {
    const wrapper = await mountGraph()

    const quadtreeBeforeRepaint = wrapper.vm.nodeQuadtree
    const clustersBeforeRepaint = wrapper.vm.clusters
    wrapper.vm.repaint()
    // -> A pure repaint must not touch layout-derived state -- same references, not just equal
    //    content, since `relayout()` always produces a brand new quadtree/clusters array.
    expect(wrapper.vm.nodeQuadtree).toBe(quadtreeBeforeRepaint)
    expect(wrapper.vm.clusters).toBe(clustersBeforeRepaint)

    wrapper.vm.relayout()
    expect(wrapper.vm.nodeQuadtree).not.toBe(quadtreeBeforeRepaint)
    expect(wrapper.vm.clusters).not.toBe(clustersBeforeRepaint)
  })

  it('the zoom handler only repaints; the simulation tick handler relayouts then repaints (OpenProject #1837)', async () => {
    const wrapper = await mountGraph()

    // -> Exercises the zoom-only path the way `attachZoom()`'s `.on('zoom', ...)` callback does
    //    (set the transform, repaint) rather than driving a real DOM zoom gesture through jsdom.
    const quadtreeBeforeZoom = wrapper.vm.nodeQuadtree
    const clustersBeforeZoom = wrapper.vm.clusters
    wrapper.vm.zoomTransform = { k: 2, x: 5, y: 5 }
    wrapper.vm.repaint()
    expect(wrapper.vm.nodeQuadtree).toBe(quadtreeBeforeZoom)
    expect(wrapper.vm.clusters).toBe(clustersBeforeZoom)

    // -> The actual registered 'tick' listener, retrieved off the live simulation the same
    //    get-form way -- confirms `startSimulation()` really wired both steps together, not just
    //    that `relayout`/`repaint` behave correctly called by hand.
    const tickListener = wrapper.vm.simulation.on('tick')
    expect(typeof tickListener).toBe('function')
    tickListener()
    expect(wrapper.vm.nodeQuadtree).not.toBe(quadtreeBeforeZoom)
    expect(wrapper.vm.clusters).not.toBe(clustersBeforeZoom)
  })

  it("sizes the fallback circle off the largest member node's edge, not just its centre (OpenProject #2296)", async () => {
    const wrapper = await mountGraph()

    // -> Distinct `folder` values put A and B in separate groups, each a single-node fallback-
    //    circle case (`maxDist` from centroid is 0) -- including a group of exactly one node at
    //    maximum radius, per the Done-when.
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    nodeA.folder = 'group-a'
    nodeB.folder = 'group-b'
    nodeA.x = 100
    nodeA.y = 100
    nodeB.x = 300
    nodeB.y = 300
    nodeA.contributors = {
      editor: 1000,
      mcp: 0,
      all: 1000,
      total: { editor: 1000, mcp: 0, all: 1000 }
    }

    wrapper.vm.computeClusters()

    expect(wrapper.vm.radiusFor(nodeA)).toBe(22) // -> pinned at MAX_CONTRIBUTOR_RADIUS
    const clusterA = wrapper.vm.clusters.find((c) => c.key === 'group-a')
    expect(clusterA.circle).toBeDefined()
    expect(clusterA.circle.r).toBeGreaterThan(wrapper.vm.radiusFor(nodeA))
  })

  it("grows hull padding by each vertex's own node radius, not a flat constant (OpenProject #2296)", async () => {
    const wrapper = await mountGraph()

    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    // -> A third node so this group has >=3 members and takes the `polygonHull` path rather than
    //    falling back to the circle case covered above.
    const nodeC = { ...nodeB, path: 'c' }
    wrapper.vm.nodes.push(nodeC)

    for (const node of [nodeA, nodeB, nodeC]) {
      node.folder = 'group-c'
    }
    nodeA.x = 0
    nodeA.y = 200
    nodeB.x = 100
    nodeB.y = 0
    nodeC.x = 200
    nodeC.y = 0
    nodeA.contributors = {
      editor: 1000,
      mcp: 0,
      all: 1000,
      total: { editor: 1000, mcp: 0, all: 1000 }
    }

    wrapper.vm.computeClusters()

    const clusterC = wrapper.vm.clusters.find((c) => c.key === 'group-c')
    expect(clusterC.hullPoints).toBeDefined()
    const cx = (nodeA.x + nodeB.x + nodeC.x) / 3
    const cy = (nodeA.y + nodeB.y + nodeC.y) / 3
    const distToNodeA = Math.hypot(nodeA.x - cx, nodeA.y - cy)
    const maxHullDist = Math.max(...clusterC.hullPoints.map(([x, y]) => Math.hypot(x - cx, y - cy)))
    // -> A flat 16px padding would fall short here since nodeA's radius (22) exceeds it -- this
    //    only passes once the hull vertex at A is pushed out by A's own radius too.
    expect(maxHullDist).toBeGreaterThan(distToNodeA + wrapper.vm.radiusFor(nodeA))
  })

  it("drawLabels offsets each label by that node's own drawn radius, not a fixed constant (OpenProject #2297)", async () => {
    const wrapper = await mountGraph()

    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    nodeA.x = 100
    nodeA.y = 100
    nodeB.x = 200
    nodeB.y = 200

    const radiusA = wrapper.vm.radiusFor(nodeA)
    const radiusB = wrapper.vm.radiusFor(nodeB)
    // -> The fixture's two nodes have different contributor counts, so their radii differ --
    //    otherwise this test couldn't distinguish "offset tracks radius" from "offset is still
    //    a constant that happens to equal both radii plus the gap".
    expect(radiusA).not.toBe(radiusB)

    wrapper.vm.ctx.fillText.mockClear()
    drawLabels(wrapper.vm.ctx, wrapper.vm.nodes, wrapper.vm.radiusFor, 1.2)

    const callA = wrapper.vm.ctx.fillText.mock.calls.find(([text]) => text === nodeA.title)
    const callB = wrapper.vm.ctx.fillText.mock.calls.find(([text]) => text === nodeB.title)

    expect(callA[1]).toBe(nodeA.x + radiusA + LABEL_GAP)
    expect(callB[1]).toBe(nodeB.x + radiusB + LABEL_GAP)
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

  it('hides the locale filter on a single-locale site (OpenProject #2294)', async () => {
    // -> FIXTURE_GRAPH's two nodes both carry locale 'en' -- the common single-locale install this
    //    work package targets. Only `.graph-view-filters`'s own `w-select` is counted: `folderDepth`
    //    is a `w-input`, not a `w-select`, so the tags filter is the only one left once locale hides.
    const wrapper = await mountGraph()

    expect(wrapper.vm.localeOptions).toEqual(['en'])
    expect(wrapper.vm.showLocaleFilter).toBe(false)
    expect(wrapper.find('.graph-view-filters').findAll('.w-select')).toHaveLength(1)
  })

  it('shows the locale filter on a multi-locale site, and clears a stale value once it hides (OpenProject #2294)', async () => {
    const multiLocaleGraph = {
      nodes: [
        { ...FIXTURE_GRAPH.nodes[0], locale: 'en' },
        { ...FIXTURE_GRAPH.nodes[1], locale: 'fr' }
      ],
      edges: FIXTURE_GRAPH.edges
    }
    const wrapper = await mountGraph({ graph: multiLocaleGraph })

    expect(wrapper.vm.localeOptions).toEqual(['en', 'fr'])
    expect(wrapper.vm.showLocaleFilter).toBe(true)
    expect(wrapper.find('.graph-view-filters').findAll('.w-select')).toHaveLength(2)

    // -> Picking a locale, then having the control disappear (simulated directly here, since this
    //    fixture's own node set never actually narrows to one locale) must not leave a stale filter
    //    value with no visible control left to clear it from.
    wrapper.vm.activeFilters.locale = 'fr'
    await flushPromises()
    expect(wrapper.vm.activeFilters.locale).toBe('fr')

    wrapper.vm.allNodes = [wrapper.vm.allNodes[0]]
    await flushPromises()

    expect(wrapper.vm.showLocaleFilter).toBe(false)
    expect(wrapper.vm.activeFilters.locale).toBe(null)
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

  // -> OpenProject #1866: the server-side node cap's truncated/totalNodes signal.
  it('captures truncated: false and totalNodes from an under-cap response', async () => {
    const wrapper = await mountGraph()

    expect(wrapper.vm.graphTruncated).toBe(false)
    expect(wrapper.vm.totalNodes).toBe(FIXTURE_GRAPH.nodes.length)
  })

  it('captures truncated: true and the true totalNodes from a capped response', async () => {
    setActivePinia(createPinia())
    const siteStore = useSiteStore()
    siteStore.id = 'site-1'
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }]
    })
    router.push('/')
    await router.isReady()

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ ...FIXTURE_GRAPH, truncated: true, totalNodes: 5000 })
    })
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ isEnabled: true }) })

    const wrapper = mount(Graph, { global: { plugins: [router, createTestI18n()] } })
    await flushPromises()

    expect(wrapper.vm.graphTruncated).toBe(true)
    expect(wrapper.vm.totalNodes).toBe(5000)
  })

  it('shows the truncation notice with the shown/total counts when the response is truncated (OpenProject #1875)', async () => {
    const wrapper = await mountGraph({ graph: FIXTURE_GRAPH_TRUNCATED })

    expect(wrapper.find('.graph-view-truncation-notice').exists()).toBe(true)
    // -> FIXTURE_GRAPH_TRUNCATED's two nodes are what the (stubbed) server actually returned;
    //    totalNodes (5000) is the true readable-page count the cap cut it down from.
    expect(wrapper.text()).toContain('Showing 2 of 5000 pages')
  })

  it('does not show the truncation notice when the response is not truncated', async () => {
    const wrapper = await mountGraph()

    expect(wrapper.find('.graph-view-truncation-notice').exists()).toBe(false)
  })
})
