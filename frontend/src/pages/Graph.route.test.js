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

    // -> Read off `allNodes` (the full fetched graph), not `nodes` (OpenProject #3333's own
    //    anchor-restricted rendered subset) -- the `en` copy is now excluded from `nodes` entirely
    //    once anchored to the `fr` copy (see `Graph.anchor.test.js`), so it has to be looked up from
    //    the unrestricted source to assert it was never pinned.
    const en = wrapper.vm.allNodes.find(
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

  it('narrows the visible node set to the anchor plus its descendants (OpenProject #3333)', async () => {
    const wrapper = await mountGraph({
      graph: MULTI_LOCALE_GRAPH,
      initialPath: '/_graph?path=reference/api',
      pageLocale: 'en'
    })

    // -> `reference/api` (en) has no descendants in this fixture, so anchoring to it leaves only
    //    itself -- the other two nodes (a different path entirely, and the same path in a different
    //    locale) are both outside its subtree. See `Graph.anchor.test.js` for the full restriction
    //    behavior; this suite only re-asserts that the ?path= mechanism this file covers now feeds
    //    that restriction, since prior to OpenProject #3333 it deliberately never narrowed anything.
    const realPaths = wrapper.vm.nodes.filter((node) => !node.synthetic).map((node) => node.path)
    expect(realPaths).toEqual(['reference/api'])
  })
})
