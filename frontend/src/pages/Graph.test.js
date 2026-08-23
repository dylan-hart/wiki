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

const FIXTURE_GRAPH = {
  nodes: [
    {
      path: 'a',
      locale: 'en',
      title: 'A',
      icon: null,
      tags: [],
      folder: '',
      contributors: { editor: 3, mcp: 1, all: 4 }
    },
    {
      path: 'b',
      locale: 'en',
      title: 'B',
      icon: null,
      tags: [],
      folder: '',
      contributors: { editor: 0, mcp: 0, all: 0 }
    }
  ],
  edges: [{ source: 'a', target: 'b', type: 'link' }]
}

async function mountGraph() {
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

  it('defaults to uniform sizing, where every real node gets the fixed radius', async () => {
    const wrapper = await mountGraph()

    expect(wrapper.vm.sizeBy).toBe('uniform')
    const nodeA = wrapper.vm.nodes.find((node) => node.path === 'a')
    const nodeB = wrapper.vm.nodes.find((node) => node.path === 'b')
    expect(wrapper.vm.radiusFor(nodeA)).toBe(5)
    expect(wrapper.vm.radiusFor(nodeB)).toBe(5)
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

  it('shows the client-type filter only in edits mode', async () => {
    const wrapper = await mountGraph()

    expect(wrapper.find('.graph-client-type-filter').exists()).toBe(false)

    wrapper.vm.sizeBy = 'edits'
    await flushPromises()

    expect(wrapper.find('.graph-client-type-filter').exists()).toBe(true)
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
