import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountGraph } from './graphFixtures.js'
import { nodeId } from './graphFilters.js'
import { LINK_CHILD_COUNT_SCALE } from './graphSimulation.js'

describe('Graph.vue filter panel keyword input (OpenProject #2478)', () => {
  it('renders a w-input labeled via graph.filters.keyword, alongside the tags/folderDepth/locale controls', async () => {
    const wrapper = await mountGraph({
      messageOverrides: { 'graph.filters.keyword': 'xx-keyword' }
    })

    const panel = wrapper.find('.graph-view-filters')
    expect(panel.exists()).toBe(true)
    expect(panel.text()).toContain('xx-keyword')
    // -> A w-input, not a w-select: `Graph.fallback.test.js` counts `.w-select`s under this panel
    //    to assert the locale filter's visibility, so the keyword control must not add one.
    expect(panel.findAll('.w-input').length).toBeGreaterThan(0)
  })

  it('binds the input to keywordQuery, starting empty', async () => {
    const wrapper = await mountGraph()

    expect(wrapper.vm.keywordQuery).toBe('')

    // -> The keyword input is the first control rendered in the filter panel.
    const input = wrapper.find('.graph-view-filters input')
    expect(input.exists()).toBe(true)

    await input.setValue('onboarding')
    expect(wrapper.vm.keywordQuery).toBe('onboarding')
  })

  it('typing a keyword does not narrow the visible node/edge set -- distinct from tags/folderDepth/locale (OpenProject #2414)', async () => {
    const wrapper = await mountGraph()

    const nodesBefore = wrapper.vm.nodes.length
    const edgesBefore = wrapper.vm.edges.length

    wrapper.vm.keywordQuery = 'onboarding'
    await flushPromises()

    expect(wrapper.vm.nodes.length).toBe(nodesBefore)
    expect(wrapper.vm.edges.length).toBe(edgesBefore)
  })

  it('keeps keywordQuery untouched by clearFilters() / the "Clear filters" action', async () => {
    const wrapper = await mountGraph()

    wrapper.vm.keywordQuery = 'onboarding'
    wrapper.vm.activeFilters.tags = ['guides']
    await flushPromises()

    wrapper.vm.clearFilters()
    await flushPromises()

    expect(wrapper.vm.activeFilters.tags).toEqual([])
    expect(wrapper.vm.keywordQuery).toBe('onboarding')
  })
})

describe("Graph.vue link distance tracks the visible set's child counts", () => {
  const docsPage = (name, tags) => ({
    path: `docs/${name}`,
    locale: 'en',
    title: name,
    icon: null,
    tags,
    folder: 'docs'
  })
  const TREE_GRAPH = {
    nodes: [
      docsPage('k1', ['keep']),
      docsPage('k2', ['keep']),
      docsPage('k3', []),
      docsPage('k4', [])
    ],
    edges: []
  }

  const idOf = (endpoint) => (typeof endpoint === 'string' ? endpoint : nodeId(endpoint))

  function docsLinkDistance(wrapper) {
    const linkForce = wrapper.vm.simulation.force('link')
    const link = linkForce.links().find((l) => idOf(l.source) === 'en:docs')
    return linkForce.distance()(link)
  }

  it("shortens the parent's link distance when children are filtered out, and lengthens it on restore", async () => {
    const wrapper = await mountGraph({ graph: TREE_GRAPH })
    const docsChildren = () => wrapper.vm.edges.filter((e) => idOf(e.source) === 'en:docs').length
    expect(docsChildren()).toBe(4)
    const fullDistance = docsLinkDistance(wrapper)

    wrapper.vm.activeFilters.tags = ['keep']
    await flushPromises()
    expect(docsChildren()).toBe(2)
    const filteredDistance = docsLinkDistance(wrapper)
    expect(filteredDistance).toBeLessThan(fullDistance)

    expect(fullDistance - filteredDistance).toBeCloseTo(
      LINK_CHILD_COUNT_SCALE * (Math.sqrt(4) - Math.sqrt(2)),
      5
    )

    wrapper.vm.activeFilters.tags = []
    await flushPromises()
    expect(docsChildren()).toBe(4)
    expect(docsLinkDistance(wrapper)).toBeCloseTo(fullDistance, 5)
  })
})
