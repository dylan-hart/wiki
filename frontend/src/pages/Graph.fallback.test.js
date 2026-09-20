import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import Graph from './Graph.vue'

import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

import {
  FIXTURE_GRAPH,
  FIXTURE_GRAPH_TRUNCATED,
  GRAPH_MESSAGES,
  mountGraph,
  NESTED_FIXTURE_GRAPH
} from './graphFixtures.js'

describe('Graph.vue fallbacks, filters and truncation', () => {
  it('recovers from a fetch failure without throwing', async () => {
    const router = await createTestRouter(['/:pathMatch(.*)*'])
    API_CLIENT.get.mockImplementationOnce(() => {
      throw new Error('network')
    })

    const { wrapper } = mountWithApp(Graph, {
      router,
      stores: { site: { id: 'site-1' } },
      messages: GRAPH_MESSAGES
    })
    await flushPromises()

    expect(wrapper.find('canvas').exists()).toBe(true)
  })

  it('hides the locale filter on a single-locale site (OpenProject #2294)', async () => {
    // -> FIXTURE_GRAPH's nodes all carry locale 'en'. The depth control is a range slider, not a
    //    `w-select`, so the tags filter is the only select left once locale hides.
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

    // -> `allNodes` is narrowed directly, because this fixture's own node set never reaches a single
    //    locale on its own; what matters is that no stale value outlives the control that set it.
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

      // -> The edge builder synthesizes a root node for the two top-level paths, and a synthetic
      //    node gets no entry of its own.
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

      // -> happy-dom does not support a leading `> ` combinator scoped to an element, so this relies
      //    on each `<li>`'s own `<a>` preceding its nested `<ul>` in document order.
      const items = wrapper.findAll('.graph-view-fallback > li')
      const docsItem = items.find((item) => item.find('a').attributes('href') === '/docs')
      const childItem = items.find((item) => item.find('a').attributes('href') === '/docs/child')

      // -> 'docs' connects to the real 'docs/child' as a link, and to the synthetic root as plain
      //    text, since a synthetic node has no page to point at.
      expect(docsItem.find('ul a').attributes('href')).toBe('/docs/child')
      expect(docsItem.find('ul').text()).toContain('(root)')
      expect(docsItem.findAll('ul a')).toHaveLength(1)

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

    it('carries a non-empty keyword forward as a `?highlight=` param on the fallback href', async () => {
      const wrapper = await mountGraph()
      wrapper.vm.keywordQuery = 'docs'
      await flushPromises()

      const link = wrapper.find('.graph-view-fallback a[href^="/a"]')
      expect(link.attributes('href')).toBe('/a?highlight=docs')
    })

    it('URL-encodes a keyword carried into the `?highlight=` param', async () => {
      const wrapper = await mountGraph()
      wrapper.vm.keywordQuery = 'a & b'
      await flushPromises()

      const link = wrapper.find('.graph-view-fallback a[href^="/a"]')
      expect(link.attributes('href')).toBe('/a?highlight=a%20%26%20b')
    })

    it('trims the keyword before deciding whether to append `?highlight=`', async () => {
      const wrapper = await mountGraph()
      wrapper.vm.keywordQuery = '  docs  '
      await flushPromises()

      const link = wrapper.find('.graph-view-fallback a[href^="/a"]')
      expect(link.attributes('href')).toBe('/a?highlight=docs')
    })

    it('adds no query param for a whitespace-only keyword', async () => {
      const wrapper = await mountGraph()
      wrapper.vm.keywordQuery = '   '
      await flushPromises()

      const link = wrapper.find('.graph-view-fallback a[href="/a"]')
      expect(link.exists()).toBe(true)
    })

    it('leaves navigation unchanged from today when no keyword is active', async () => {
      const wrapper = await mountGraph()

      const link = wrapper.find('.graph-view-fallback a[href="/a"]')
      expect(link.exists()).toBe(true)
    })

    it('navigateToNode (a real canvas click) carries the same keyword the fallback href does', async () => {
      const wrapper = await mountGraph()
      wrapper.vm.keywordQuery = 'docs'
      await flushPromises()

      const link = wrapper.find('.graph-view-fallback a[href^="/a"]')
      await link.trigger('click')
      await flushPromises()

      expect(wrapper.vm.$router.currentRoute.value.fullPath).toBe('/a?highlight=docs')
      expect(wrapper.vm.$router.currentRoute.value.query.highlight).toBe('docs')
    })
  })

  it('captures truncated: false and totalNodes from an under-cap response', async () => {
    const wrapper = await mountGraph()

    expect(wrapper.vm.graphTruncated).toBe(false)
    expect(wrapper.vm.totalNodes).toBe(FIXTURE_GRAPH.nodes.length)
  })

  it('captures truncated: true and the true totalNodes from a capped response', async () => {
    const router = await createTestRouter(['/:pathMatch(.*)*'])

    API_CLIENT.get.mockReturnValueOnce({
      json: () => Promise.resolve({ ...FIXTURE_GRAPH, truncated: true, totalNodes: 5000 })
    })
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ isEnabled: true }) })

    const { wrapper } = mountWithApp(Graph, {
      router,
      stores: { site: { id: 'site-1' } },
      messages: GRAPH_MESSAGES
    })
    await flushPromises()

    expect(wrapper.vm.graphTruncated).toBe(true)
    expect(wrapper.vm.totalNodes).toBe(5000)
  })

  it('shows the truncation notice with the shown/total counts when the response is truncated (OpenProject #1875)', async () => {
    const wrapper = await mountGraph({ graph: FIXTURE_GRAPH_TRUNCATED })

    expect(wrapper.find('.graph-view-truncation-notice').exists()).toBe(true)
    // -> 2 is what the stubbed server returned; 5000 is the true readable-page count the cap cut it
    //    down from.
    expect(wrapper.text()).toContain('Showing 2 of 5000 pages')
  })

  it('does not show the truncation notice when the response is not truncated', async () => {
    const wrapper = await mountGraph()

    expect(wrapper.find('.graph-view-truncation-notice').exists()).toBe(false)
  })
})
