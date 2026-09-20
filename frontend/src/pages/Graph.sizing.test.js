import { describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { drawLabels, LABEL_MAX_EFFECTIVE_FONT_PX } from './graphDraw.js'
import { nodeId } from './graphFilters.js'
import { childCountsFor, linkDistanceFor } from './graphSimulation.js'
import { FIXTURE_GRAPH, GRAPH_MESSAGES, mountGraph } from './graphFixtures.js'
import Graph from './Graph.vue'
import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

describe('Graph.vue node sizing and the control rail', () => {
  it('defaults to edits sizing (no "uniform" mode any more) while pageview tracking is off, scaling by contributor count', async () => {
    const wrapper = await mountGraph()

    expect(wrapper.vm.sizeBy).toBe('edits')
    expect(wrapper.vm.sizeCountMode).toBe('total')
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
    // -> Pinned explicitly (the default is 'total') so the unique-count figures below stay
    //    meaningful.
    wrapper.vm.sizeCountMode = 'unique'

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

    // -> Each sizing mode has its own client-type filter (`contributorTypes`,
    //    `pageviewClientTypes`) and both render through the same `GraphClientTypeFilter`, so
    //    switching modes swaps which one shows rather than making the filter disappear.
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
    // -> Pinned explicitly (the default is 'total') so the unique-count figures below stay
    //    meaningful.
    wrapper.vm.sizeCountMode = 'unique'

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

    // -> The window selector is 'visits'-only, unlike the client-type filter the default 'edits'
    //    mode already shows.
    expect(wrapper.text()).not.toContain('30 days')

    wrapper.vm.sizeBy = 'visits'
    await flushPromises()

    expect(wrapper.find('.graph-client-type-filter').exists()).toBe(true)
    expect(wrapper.text()).toContain('30 days')
  })

  it('offers "Edits" and "Visits" sizing labels, with no "Uniform" option, when tracking is enabled', async () => {
    const wrapper = await mountGraph({ pageviewsEnabled: true })

    expect(wrapper.vm.sizeByOptions).toEqual([
      { label: 'Visits', value: 'visits' },
      { label: 'Edits', value: 'edits' }
    ])
  })

  it('hides "Visits" sizing entirely when tracking is disabled, leaving only "Edits" -- and sizeBy never selects an option sizeByOptions doesn\'t offer', async () => {
    const wrapper = await mountGraph({ pageviewsEnabled: false })

    expect(wrapper.vm.sizeByOptions).toEqual([{ label: 'Edits', value: 'edits' }])
    expect(wrapper.vm.sizeBy).toBe('edits')
  })

  // -> `pageviewsTrackingEnabled` resolves asynchronously, after `loadGraph()`'s own fetch, so a
  //    `sizeBy` default computed at declaration time can never see it. `mountGraph()` awaits that
  //    resolution before returning.
  it("defaults to visits sizing once pageview tracking resolves enabled, having never sat at an option sizeByOptions didn't offer", async () => {
    const wrapper = await mountGraph({ pageviewsEnabled: true })

    expect(wrapper.vm.pageviewsTrackingEnabled).toBe(true)
    expect(wrapper.vm.sizeBy).toBe('visits')
    expect(wrapper.vm.sizeByOptions).toEqual([
      { label: 'Visits', value: 'visits' },
      { label: 'Edits', value: 'edits' }
    ])
  })

  // -> A known limitation, not a guarantee: with no persisted preference for this reader, an
  //    explicit re-selection of 'edits' is indistinguishable from the untouched default the moment
  //    tracking resolves enabled, so it is promoted to 'visits' just the same. A persisted
  //    preference is what protects a deliberate choice.
  it('cannot yet distinguish an explicit re-selection of "edits" from the untouched default before tracking resolves enabled', async () => {
    const router = await createTestRouter(['/:pathMatch(.*)*'])
    let resolveTracking
    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve(structuredClone(FIXTURE_GRAPH))
    })
    API_CLIENT.get.mockReturnValueOnce({
      json: () =>
        new Promise((resolve) => {
          resolveTracking = resolve
        })
    })
    const { wrapper } = mountWithApp(Graph, {
      router,
      stores: { site: { id: 'site-1' } },
      messages: GRAPH_MESSAGES
    })
    await flushPromises()

    wrapper.vm.sizeBy = 'edits'
    resolveTracking({ isEnabled: true })
    await flushPromises()

    expect(wrapper.vm.sizeBy).toBe('visits')
  })

  it('falls back to edits sizing (no "uniform" mode any more) if tracking turns off while visits mode is active', async () => {
    const wrapper = await mountGraph({ pageviewsEnabled: true })
    wrapper.vm.sizeBy = 'visits'
    await flushPromises()

    wrapper.vm.pageviewsTrackingEnabled = false
    await flushPromises()

    expect(wrapper.vm.sizeBy).toBe('edits')
  })

  it('renders the Unique/Total "Count" toggle, defaulting to Total', async () => {
    const wrapper = await mountGraph()

    expect(wrapper.text()).toContain('Unique')
    expect(wrapper.text()).toContain('Total')
    expect(wrapper.vm.sizeCountMode).toBe('total')
  })

  it('sizeCountMode toggle switches contributorCountFor between the unique and total fields', async () => {
    const wrapper = await mountGraph()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    // -> Start from 'unique' explicitly (the default is 'total') so the toggle itself, not the
    //    resting default, is what moves the count.
    wrapper.vm.sizeCountMode = 'unique'

    expect(wrapper.vm.contributorCountFor(nodeA)).toBe(4)

    wrapper.vm.sizeCountMode = 'total'
    expect(wrapper.vm.contributorCountFor(nodeA)).toBe(9)
  })

  it('sizeCountMode toggle switches pageviewCountFor between the unique and total fields', async () => {
    const wrapper = await mountGraph()
    wrapper.vm.sizeBy = 'visits'
    wrapper.vm.sizeCountMode = 'unique'
    await flushPromises()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')

    expect(wrapper.vm.pageviewCountFor(nodeA)).toBe(12)

    wrapper.vm.sizeCountMode = 'total'
    expect(wrapper.vm.pageviewCountFor(nodeA)).toBe(30)
  })

  it('sizeCountMode toggle can flip which node ranks bigger, since radiusFor lerps against the current graph’s own range (OpenProject #2561)', async () => {
    const wrapper = await mountGraph()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    // -> B's total count outranks A's while its unique count still trails A's. `radiusFor` lerps
    //    against the graph's own range, so only which node comes out on top under each mode
    //    distinguishes the toggle from a same-node "total > unique" comparison.
    wrapper.vm.sizeCountMode = 'unique'
    nodeB.contributors = { editor: 2, mcp: 0, all: 2, total: { editor: 20, mcp: 0, all: 20 } }

    expect(wrapper.vm.radiusFor(nodeA)).toBeGreaterThan(wrapper.vm.radiusFor(nodeB))

    wrapper.vm.sizeCountMode = 'total'

    expect(wrapper.vm.radiusFor(nodeB)).toBeGreaterThan(wrapper.vm.radiusFor(nodeA))
  })

  it('draws the graph’s smallest-ranked real node at exactly MIN_NODE_RADIUS, 20 (OpenProject #2900)', async () => {
    const wrapper = await mountGraph()

    // -> The fixture's B has a zero contributor count, so it is the bottom of the graph's observed
    //    range and lands exactly on the floor. `MIN_NODE_RADIUS` is a `<script setup>`-local const
    //    with no export, so `radiusFor()` is the only surface that can pin its value.
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')

    expect(wrapper.vm.radiusFor(nodeB)).toBe(20)
    expect(wrapper.vm.radiusFor(nodeA)).toBe(110)
  })

  it('puts every real node on the floor in the degenerate all-same-count case (OpenProject #2594)', async () => {
    const wrapper = await mountGraph()

    // -> One count shared by every node is a zero-width range, which `lerpRadius()` resolves to
    //    `minRadius` rather than dividing by zero.
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    const shared = { editor: 7, mcp: 0, all: 7, total: { editor: 7, mcp: 0, all: 7 } }
    nodeA.contributors = { ...shared }
    nodeB.contributors = { ...shared }
    // -> `currentMetricRange` is a plain variable, not a `computed` (nodes are `markRaw`'d out of
    //    reactivity), so an in-place count edit needs this refresh before `radiusFor()` sees it.
    wrapper.vm.computeClusters()

    expect(wrapper.vm.radiusFor(nodeA)).toBe(20)
    expect(wrapper.vm.radiusFor(nodeB)).toBe(20)
  })

  it('keeps synthetic folder/root nodes at their own fixed 3, below the real-node floor (OpenProject #2594)', async () => {
    const wrapper = await mountGraph()

    // -> `radiusFor()` short-circuits on `node.synthetic` before the lerp, so `MIN_NODE_RADIUS`
    //    never moves a synthetic hub: a "below the minimum node radius" rule selects exactly these.
    expect(wrapper.vm.radiusFor({ synthetic: true })).toBe(3)
  })

  it('drawLabels never hides labels for being zoomed out -- the zoom-linked visibility threshold was removed entirely (OpenProject #3027)', async () => {
    const wrapper = await mountGraph()

    // -> `0.05` is far below any zoom a visibility threshold would plausibly have been tuned to.
    wrapper.vm.ctx.fillText.mockClear()
    drawLabels(wrapper.vm.ctx, wrapper.vm.nodes, wrapper.vm.radiusFor, 0.05)
    expect(wrapper.vm.ctx.fillText).toHaveBeenCalled()

    wrapper.vm.ctx.fillText.mockClear()
    drawLabels(wrapper.vm.ctx, wrapper.vm.nodes, wrapper.vm.radiusFor, 0.7)
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
    expect(Number(atMaxZoomPx) * 8).toBeLessThanOrEqual(LABEL_MAX_EFFECTIVE_FONT_PX)
  })

  it('paintGraph feeds the live zoom scale into drawLabels, not a fixed 1', async () => {
    const wrapper = await mountGraph()

    // -> Through `repaint()` -> `paintGraph({ transform: zoomTransform })`, the app's only caller,
    //    rather than calling `drawLabels` with a scale as the tests above do: a `paintGraph` that
    //    hardcoded `1` would draw 10px labels at every zoom. Labels are never hidden for being
    //    zoomed out, so `0.5` is asserted to draw rather than to stay silent.
    wrapper.vm.zoomTransform = { k: 0.5, x: 0, y: 0 }
    wrapper.vm.ctx.fillText.mockClear()
    wrapper.vm.repaint()
    expect(wrapper.vm.ctx.fillText).toHaveBeenCalled()

    wrapper.vm.zoomTransform = { k: 4, x: 0, y: 0 }
    wrapper.vm.ctx.fillText.mockClear()
    wrapper.vm.repaint()
    expect(wrapper.vm.ctx.fillText).toHaveBeenCalled()
    const [drawnFontPx] = wrapper.vm.ctx.font.match(/[\d.]+/)
    expect(Number(drawnFontPx)).toBeLessThan(10)
    expect(Number(drawnFontPx) * 4).toBeLessThanOrEqual(LABEL_MAX_EFFECTIVE_FONT_PX)
  })

  it("re-attaches forceLink's own target distance (not just forceCollide) after a live sizing change, so link distances don't go stale (OpenProject #2749)", async () => {
    const wrapper = await mountGraph()

    // -> d3-force's `forceLink().distance(fn)` setter is the only thing that makes it re-read every
    //    link's endpoint radii (it calls `initializeDistance()` synchronously) -- the same
    //    one-time-at-attach shape `collide` has. Spying on the public accessor tests that directly,
    //    without depending on d3-force's private tick math.
    const linkForce = wrapper.vm.simulation.force('link')
    const distanceSpy = vi.spyOn(linkForce, 'distance')

    // -> 'total' is the resting default and only a real value change fires the watcher, so flip
    //    through 'unique' first.
    wrapper.vm.sizeCountMode = 'unique'
    await flushPromises()
    distanceSpy.mockClear()

    wrapper.vm.sizeCountMode = 'total'
    await flushPromises()

    expect(distanceSpy).toHaveBeenCalled()

    // -> The re-attached function must compute off the post-toggle radii, not merely be a
    //    function, so the expectation recomputes `linkDistanceFor()` for a real link.
    const setterCall = distanceSpy.mock.calls.findLast((args) => args.length === 1)
    expect(setterCall).toBeDefined()
    const [newDistanceFn] = setterCall
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    const expected = linkDistanceFor(
      { source: nodeA, target: nodeB },
      (node) => wrapper.vm.radiusFor(node) + 2,
      (node) => childCountsFor(wrapper.vm.edges).get(nodeId(node)) ?? 0
    )
    expect(newDistanceFn({ source: nodeA, target: nodeB })).toBeCloseTo(expected, 5)
  })
})
