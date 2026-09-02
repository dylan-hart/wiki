import { describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { isReactive } from 'vue'

import Graph from './Graph.vue'

import { createTestRouter } from '../../test/router.js'
import { mountWithApp } from '../../test/mount.js'

import { drawLabels, LABEL_GAP } from './graphDraw.js'
import {
  FIXTURE_GRAPH,
  FIXTURE_GRAPH_TRUNCATED,
  GRAPH_MESSAGES,
  ZERO_PAGEVIEWS,
  mountGraph,
  NESTED_FIXTURE_GRAPH
} from './graphFixtures.js'

/*
 * Asserting actual pixel output is out of practical reach for a unit test -- a real
 * testing-strategy limitation, not an oversight (per the design spec's own admission). This suite
 * checks the simulation initializes, the canvas element exists, and every edge/group mode switch
 * lands, without throwing.
 */
describe('Graph.vue rendering (OpenProject #891)', () => {
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

  // -> OpenProject #1621/#1629: `forceLink().id()` used to resolve on the bare `path`, so an
  //    `en`/`fr` pair sharing a path collapsed to a single d3-force node with no error.
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
})
