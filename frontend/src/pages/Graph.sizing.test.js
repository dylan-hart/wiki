import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { drawLabels, LABEL_MAX_EFFECTIVE_FONT_PX } from './graphDraw.js'
import { mountGraph } from './graphFixtures.js'

/*
 * How a node's radius is derived -- which counter it reads (contributors vs pageviews), which
 * bucket of that counter (unique vs total, and which client types), over which window -- plus the
 * control-rail affordances that pick between them, and the label layer's zoom thresholds.
 */
describe('Graph.vue node sizing and the control rail', () => {
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

  it('sizeCountMode toggle can flip which node ranks bigger, since radiusFor lerps against the current graph’s own range (OpenProject #2561)', async () => {
    const wrapper = await mountGraph()
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    // -> B's total count outranks A's, while its unique count still trails A's -- so this is only
    //    distinguishable from a same-node "total > unique" comparison (which no longer holds on its
    //    own now that radiusFor is normalized against the graph's own range, not an absolute scale)
    //    by checking which of the two nodes comes out on top under each mode.
    nodeB.contributors = { editor: 2, mcp: 0, all: 2, total: { editor: 20, mcp: 0, all: 20 } }

    expect(wrapper.vm.radiusFor(nodeA)).toBeGreaterThan(wrapper.vm.radiusFor(nodeB))

    wrapper.vm.sizeCountMode = 'total'

    expect(wrapper.vm.radiusFor(nodeB)).toBeGreaterThan(wrapper.vm.radiusFor(nodeA))
  })

  it('draws the graph’s smallest-ranked real node at exactly MIN_NODE_RADIUS, 10 (OpenProject #2594)', async () => {
    const wrapper = await mountGraph()

    // -> The fixture's B has a zero contributor count, so it IS the bottom of the graph's own
    //    observed range and lands exactly on the floor. Pinning the floor's VALUE (not merely
    //    "B is smaller than A") is the point: `MIN_NODE_RADIUS` is a `<script setup>`-local const
    //    with no export, so `radiusFor()` is the only surface that can assert what it is, and
    //    nothing did before this Task doubled it from `5`.
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')

    expect(wrapper.vm.radiusFor(nodeB)).toBe(10)
    expect(wrapper.vm.radiusFor(nodeA)).toBe(110)
  })

  it('puts every real node on the floor in the degenerate all-same-count case (OpenProject #2594)', async () => {
    const wrapper = await mountGraph()

    // -> Every loaded node sharing one count is a zero-width sqrt range, which `lerpRadius()`
    //    resolves to `minRadius` rather than dividing by zero (`graphNodeSize.js`). Re-checked
    //    end-to-end through `radiusFor()` against the doubled floor, since `graphNodeSize.test.js`
    //    only covers the pure function with hand-passed bounds.
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    const shared = { editor: 7, mcp: 0, all: 7, total: { editor: 7, mcp: 0, all: 7 } }
    nodeA.contributors = { ...shared }
    nodeB.contributors = { ...shared }
    // -> `currentMetricRange` is a plain variable, not a `computed` (node objects are `markRaw`'d
    //    out of Vue's reactivity), so an in-place edit to a node's counts needs an explicit refresh
    //    before `radiusFor()` reads the new range -- same call `Graph.layout.test.js` makes.
    wrapper.vm.computeClusters()

    expect(wrapper.vm.radiusFor(nodeA)).toBe(10)
    expect(wrapper.vm.radiusFor(nodeB)).toBe(10)
  })

  it('keeps synthetic folder/root nodes at their own fixed 3, below the real-node floor (OpenProject #2594)', async () => {
    const wrapper = await mountGraph()

    // -> `radiusFor()` short-circuits on `node.synthetic` before the lerp ever runs, so doubling
    //    `MIN_NODE_RADIUS` deliberately does NOT move a synthetic hub -- worth pinning, because it
    //    is what makes a radius-keyed rule "below the minimum node radius" (sibling Task #2593)
    //    select synthetic nodes and nothing else.
    expect(wrapper.vm.radiusFor({ synthetic: true })).toBe(3)
  })

  it('drawLabels hides labels below the visibility threshold, shows them at/above it (OpenProject #2593, #2292, #1287/#1288)', async () => {
    const wrapper = await mountGraph()

    // -> `0.7` sits between the old `0.75` threshold (OpenProject #2292) and the new, lower `0.6`
    //    (OpenProject #2593) -- proving labels now persist at a zoom level that used to hide them,
    //    the same way `0.8` proved it against the `1.1` before that. Mount's own initial draw (at
    //    the default `k = 1` zoom, itself above the threshold) already logged fillText calls, so
    //    clear those before asserting on the below-threshold case.
    wrapper.vm.ctx.fillText.mockClear()
    drawLabels(wrapper.vm.ctx, wrapper.vm.nodes, wrapper.vm.radiusFor, 0.5)
    expect(wrapper.vm.ctx.fillText).not.toHaveBeenCalled()

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
    expect(Number(drawnFontPx) * 4).toBeLessThanOrEqual(LABEL_MAX_EFFECTIVE_FONT_PX)
  })
})
