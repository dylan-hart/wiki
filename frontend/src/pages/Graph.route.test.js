import { describe, expect, it } from 'vitest'

import { mountGraph } from './graphFixtures.js'

/*
 * OpenProject #3312 (Feature #3311): `Graph.vue` reads the `?path=` query param once, on the
 * initial `loadGraph()`, and centers/highlights whichever node it resolves to -- scoped to
 * `pageStore.locale` (the locale of the page the reader was reading before navigating to the
 * graph), since `route.query.path` is a bare, un-prefixed path and two locales can share one.
 */

const MULTI_LOCALE_GRAPH = {
  nodes: [
    {
      path: 'guides/onboarding',
      locale: 'en',
      title: 'Onboarding Guide',
      icon: null,
      tags: [],
      folder: 'guides'
    },
    {
      path: 'guides/onboarding',
      locale: 'fr',
      title: 'Guide d’intégration',
      icon: null,
      tags: [],
      folder: 'guides'
    },
    {
      path: 'reference/api',
      locale: 'en',
      title: 'API Reference',
      icon: null,
      tags: [],
      folder: 'reference'
    }
  ],
  edges: []
}

describe('Graph.vue ?path= route focus (OpenProject #3312)', () => {
  it('leaves centering/highlighting untouched when no ?path= param is present', async () => {
    const wrapper = await mountGraph({ initialPath: '/_graph' })

    expect(wrapper.vm.focusNodeId).toBeNull()
    expect(wrapper.vm.highlightedNodeIds.size).toBe(0)
    for (const node of wrapper.vm.nodes) {
      expect(node.fx == null).toBe(true)
      expect(node.fy == null).toBe(true)
    }
  })

  it('resolves, pins and highlights the node named by ?path= in the current page locale', async () => {
    const wrapper = await mountGraph({
      graph: MULTI_LOCALE_GRAPH,
      initialPath: '/_graph?path=reference/api',
      pageLocale: 'en'
    })

    const target = wrapper.vm.nodes.find(
      (node) => node.path === 'reference/api' && node.locale === 'en'
    )
    expect(wrapper.vm.focusNodeId).toBe('en:reference/api')
    expect(wrapper.vm.highlightedNodeIds.has('en:reference/api')).toBe(true)
    // -> Pinned to the same (width/2, height/2) point `startSimulation()`'s own `forceCenter` uses --
    //    jsdom has no layout engine, so `containerRef`'s `getBoundingClientRect()` is zeroed here,
    //    same as every other Graph suite that reads it (see `Graph.controlLayout.test.js`).
    expect(target.fx).toBe(0)
    expect(target.fy).toBe(0)
  })

  it('scopes the match to pageStore.locale -- a same-path node in a DIFFERENT locale is not pinned', async () => {
    const wrapper = await mountGraph({
      graph: MULTI_LOCALE_GRAPH,
      initialPath: '/_graph?path=guides/onboarding',
      pageLocale: 'fr'
    })

    const en = wrapper.vm.nodes.find(
      (node) => node.path === 'guides/onboarding' && node.locale === 'en'
    )
    const fr = wrapper.vm.nodes.find(
      (node) => node.path === 'guides/onboarding' && node.locale === 'fr'
    )
    expect(wrapper.vm.focusNodeId).toBe('fr:guides/onboarding')
    expect(fr.fx).toBe(0)
    expect(fr.fy).toBe(0)
    expect(en.fx == null).toBe(true)
    expect(en.fy == null).toBe(true)
  })

  it('is a silent no-op for a ?path= naming a page that does not exist in this graph', async () => {
    const wrapper = await mountGraph({
      graph: MULTI_LOCALE_GRAPH,
      initialPath: '/_graph?path=nonexistent/page',
      pageLocale: 'en'
    })

    expect(wrapper.vm.focusNodeId).toBeNull()
    expect(wrapper.vm.highlightedNodeIds.size).toBe(0)
    for (const node of wrapper.vm.nodes) {
      expect(node.fx == null).toBe(true)
      expect(node.fy == null).toBe(true)
    }
  })

  it('does not narrow the visible node/edge set -- only changes the centering/highlight target', async () => {
    const wrapper = await mountGraph({
      graph: MULTI_LOCALE_GRAPH,
      initialPath: '/_graph?path=reference/api',
      pageLocale: 'en'
    })

    // -> Every node from the fixture graph is still present -- the focus param highlights, it does
    //    not filter (same scope note `computeHighlightedNodeIds`'s own doc comment makes).
    expect(wrapper.vm.nodes.filter((node) => !node.synthetic)).toHaveLength(3)
  })
})

/*
 * OpenProject #3337: the Graph nav button now sends the current page's nearest containing folder
 * (root for a top-level page) rather than the page itself, so `?path=` commonly names a synthetic
 * folder/root node -- these assert `applyRouteFocus()` resolves, pins and highlights one of those,
 * not only a real page node.
 */
describe('Graph.vue ?path= route focus resolves a synthetic folder/root anchor (OpenProject #3337)', () => {
  it('resolves, pins and highlights the synthetic folder node named by ?path=', async () => {
    const wrapper = await mountGraph({
      graph: MULTI_LOCALE_GRAPH,
      initialPath: '/_graph?path=guides',
      pageLocale: 'en'
    })

    const folderNode = wrapper.vm.nodes.find(
      (node) => node.synthetic && node.path === 'guides' && node.locale === 'en'
    )
    expect(folderNode).toBeTruthy()
    expect(wrapper.vm.focusNodeId).toBe('en:guides')
    expect(wrapper.vm.highlightedNodeIds.has('en:guides')).toBe(true)
    expect(folderNode.fx).toBe(0)
    expect(folderNode.fy).toBe(0)
  })

  it('resolves, pins and highlights the synthetic root node for an explicit empty ?path=', async () => {
    const wrapper = await mountGraph({
      graph: MULTI_LOCALE_GRAPH,
      initialPath: '/_graph?path=',
      pageLocale: 'en'
    })

    const rootNode = wrapper.vm.nodes.find(
      (node) => node.synthetic && node.path === '' && node.locale === 'en'
    )
    expect(rootNode).toBeTruthy()
    expect(wrapper.vm.focusNodeId).toBe('en:')
    expect(wrapper.vm.highlightedNodeIds.has('en:')).toBe(true)
    expect(rootNode.fx).toBe(0)
    expect(rootNode.fy).toBe(0)
  })
})
