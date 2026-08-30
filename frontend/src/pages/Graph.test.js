import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createI18n } from 'vue-i18n'
import { isReactive } from 'vue'

import Graph from './Graph.vue'
import { useSiteStore } from '@/stores/site'

/** Mirrors `backend/locales/en.json`'s `graph.*` namespace (OpenProject #1690) -- kept here rather
 *  than imported so this suite doesn't depend on the real locale file's exact key set, only on the
 *  component asking `t()` for these specific keys with these specific meanings. The two `tooltip.*`
 *  entries use vue-i18n's pipe-delimited plural syntax (`singular | plural`), same as the real file. */
const GRAPH_MESSAGES = {
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

/** Options for `API_CLIENT.get('system/pageviews')` -- defaults to tracking enabled so the
 *  'visits' sizing option is available in the default `mountGraph()` fixture; a test asserting the
 *  disabled case passes `{ pageviewsEnabled: false }`. `graph` defaults to `FIXTURE_GRAPH`; a test
 *  exercising a different node/edge shape (OpenProject #1629's locale-duplicate case) passes its
 *  own. `messageOverrides` is forwarded to `createTestI18n()` for a test asserting one specific
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
    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/graph')
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
        'graph.tooltip.visits': '{count} xx-one-visit | {count} xx-many-visits'
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
})
