import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import Graph from './Graph.vue'

import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

import { FIXTURE_GRAPH, GRAPH_MESSAGES, ZERO_PAGEVIEWS, mountGraph } from './graphFixtures.js'

/*
 * Pixel output is out of practical reach for a unit test, so this suite checks that the simulation
 * initializes, the canvas exists and each mode switch lands without throwing, never what is drawn.
 */
describe('Graph.vue rendering (OpenProject #891)', () => {
  it('mounts, fetches the graph, and renders a canvas with no console errors', async () => {
    const wrapper = await mountGraph()

    expect(wrapper.find('canvas').exists()).toBe(true)
    expect(API_CLIENT.get).toHaveBeenCalledWith('sites/site-1/graph', {
      searchParams: { sizing: 'edits' }
    })
  })

  // -> The test above mounts at the default mode, so it cannot tell a `sizing` param that tracks
  //    `sizeBy` apart from a hardcoded 'edits'.
  it('sends the currently-active sizeBy mode as the sizing param on (re)load', async () => {
    const router = await createTestRouter(['/:pathMatch(.*)*'])

    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(FIXTURE_GRAPH) })
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve({ isEnabled: true }) })
    const { wrapper } = mountWithApp(Graph, {
      router,
      stores: { site: { id: 'site-1' } },
      messages: GRAPH_MESSAGES
    })
    await flushPromises()

    wrapper.vm.sizeBy = 'visits'
    API_CLIENT.get.mockReturnValueOnce({ json: () => Promise.resolve(FIXTURE_GRAPH) })
    await wrapper.vm.loadGraph()

    expect(API_CLIENT.get).toHaveBeenLastCalledWith('sites/site-1/graph', {
      searchParams: { sizing: 'visits' }
    })
  })

  // -> A `forceLink().id()` resolving on the bare `path` collapses an `en`/`fr` pair into a single
  //    d3-force node silently, with no error.
  it('same-path translations render as two distinct, separately-keyed nodes', async () => {
    const router = await createTestRouter(['/:pathMatch(.*)*'])

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

    const { wrapper } = mountWithApp(Graph, {
      router,
      stores: { site: { id: 'site-1' } },
      messages: GRAPH_MESSAGES
    })
    await flushPromises()

    const realNodes = wrapper.vm.nodes.filter((node) => !node.synthetic)
    expect(realNodes).toHaveLength(2)
    expect(realNodes.map((node) => node.id).sort()).toEqual(['en:docs/intro', 'fr:docs/intro'])
    // -> Translations are same-path by design; the locale, not the path, is what keeps them apart.
    expect(realNodes.every((node) => node.path === 'docs/intro')).toBe(true)
    expect(realNodes[0]).not.toBe(realNodes[1])
  })

  it('adds synthetic folder/root nodes to the visible set (the graph is always a path hierarchy, OpenProject #2580)', async () => {
    const wrapper = await mountGraph()

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

    // -> No locale filter, so both translations stay visible together and the path-hierarchy edge
    //    builder chains each into the simulation.
    const wrapper = await mountGraph({ graph: { nodes: [enIntro, frIntro], edges: [] } })

    const simNodes = wrapper.vm.nodes.filter((n) => n.path === 'intro')
    expect(simNodes).toHaveLength(2)
    expect(simNodes[0]).not.toBe(simNodes[1])

    // -> d3-force resolves each edge's `source`/`target` to the node object it matched by id when
    //    the link force is attached, so a path-keyed accessor hands both edges the same object.
    const introLinks = wrapper.vm.simulation
      .force('link')
      .links()
      .filter((link) => link.target.path === 'intro')
    expect(introLinks).toHaveLength(2)
    expect(introLinks[0].target).not.toBe(introLinks[1].target)
  })

  it('switching groupBy to classification (OpenProject #1217) does not throw', async () => {
    const wrapper = await mountGraph()

    wrapper.vm.groupBy = 'classification'
    await flushPromises()

    expect(wrapper.find('canvas').exists()).toBe(true)
  })
})
