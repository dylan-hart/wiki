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

/*
 * The paths that are not the happy one: a failed fetch, the locale filter appearing and clearing
 * itself, the sr-only keyboard/screen-reader fallback list (OpenProject #1686), and the truncation
 * notice a capped response raises (OpenProject #1866/#1875).
 */
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
    // -> FIXTURE_GRAPH_TRUNCATED's two nodes are what the (stubbed) server actually returned;
    //    totalNodes (5000) is the true readable-page count the cap cut it down from.
    expect(wrapper.text()).toContain('Showing 2 of 5000 pages')
  })

  it('does not show the truncation notice when the response is not truncated', async () => {
    const wrapper = await mountGraph()

    expect(wrapper.find('.graph-view-truncation-notice').exists()).toBe(false)
  })
})
