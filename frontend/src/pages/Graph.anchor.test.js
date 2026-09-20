import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import { mountGraph } from './graphFixtures.js'

// An unrelated sibling tree ('blog') and an unrelated root-level page ('about') alongside a three-
// deep chain: enough shape to exercise ancestor/sibling/descendant exclusion and the depth-from-
// anchor reinterpretation together.
const ANCHOR_TREE_GRAPH = {
  nodes: [
    { path: 'docs', locale: 'en', title: 'Docs', icon: null, tags: [], folder: '' },
    { path: 'docs/child', locale: 'en', title: 'Child', icon: null, tags: [], folder: 'docs' },
    {
      path: 'docs/child/grandchild',
      locale: 'en',
      title: 'Grandchild',
      icon: null,
      tags: [],
      folder: 'docs/child'
    },
    { path: 'blog', locale: 'en', title: 'Blog', icon: null, tags: [], folder: '' },
    { path: 'blog/post', locale: 'en', title: 'Post', icon: null, tags: [], folder: 'blog' },
    { path: 'about', locale: 'en', title: 'About', icon: null, tags: [], folder: '' }
  ],
  edges: []
}

describe('Graph.vue anchor + descendants restriction (OpenProject #3333)', () => {
  it('restricts the rendered node set to the anchor plus its descendants when anchored to a non-root node', async () => {
    const wrapper = await mountGraph({
      graph: ANCHOR_TREE_GRAPH,
      initialPath: '/_graph?path=docs/child',
      pageLocale: 'en'
    })

    const realPaths = wrapper.vm.nodes
      .filter((node) => !node.synthetic)
      .map((node) => node.path)
      .sort()
    expect(realPaths).toEqual(['docs/child', 'docs/child/grandchild'])
  })

  it('excludes root and every other ancestor ABOVE the anchor from the synthetic hierarchy too (OpenProject #3361)', async () => {
    // -> Asserts against ALL paths, unlike every other test here: a `buildPathHierarchyEdges()`
    //    that climbs a restricted node's full ancestor chain re-synthesizes the excluded ancestors
    //    back in, and a `!node.synthetic` filter would hide exactly that.
    const wrapper = await mountGraph({
      graph: ANCHOR_TREE_GRAPH,
      initialPath: '/_graph?path=docs/child',
      pageLocale: 'en'
    })

    const allPaths = wrapper.vm.nodes.map((node) => node.path)
    expect(allPaths).not.toContain('')
    expect(allPaths).not.toContain('docs')
    // -> The anchor itself ('docs/child') and its own descendant folder chain still draw -- this is
    //    restriction of what's ABOVE the anchor, not a ban on every synthetic node.
    expect(allPaths).toContain('docs/child')
  })

  it("excludes the anchor's own ancestor and unrelated trees", async () => {
    const wrapper = await mountGraph({
      graph: ANCHOR_TREE_GRAPH,
      initialPath: '/_graph?path=docs/child',
      pageLocale: 'en'
    })

    const realPaths = wrapper.vm.nodes.filter((node) => !node.synthetic).map((node) => node.path)
    expect(realPaths).not.toContain('docs')
    expect(realPaths).not.toContain('blog')
    expect(realPaths).not.toContain('blog/post')
    expect(realPaths).not.toContain('about')
  })

  it('leaves the full graph visible when no ?path= anchor is present, same as before this WP', async () => {
    const wrapper = await mountGraph({ graph: ANCHOR_TREE_GRAPH })

    const realPaths = wrapper.vm.nodes.filter((node) => !node.synthetic)
    expect(realPaths).toHaveLength(ANCHOR_TREE_GRAPH.nodes.length)
  })

  it('reinterprets activeFilters.folderDepth as hops-from-the-anchor while anchored', async () => {
    const wrapper = await mountGraph({
      graph: ANCHOR_TREE_GRAPH,
      initialPath: '/_graph?path=docs/child',
      pageLocale: 'en'
    })

    // -> Depth 0 relative to the anchor is the anchor alone, even though `docs/child` itself sits
    //    at root-relative depth 1 -- a root-relative depth-0 filter would have excluded it entirely.
    wrapper.vm.activeFilters.folderDepth = 0
    await flushPromises()
    expect(wrapper.vm.nodes.filter((n) => !n.synthetic).map((n) => n.path)).toEqual(['docs/child'])

    wrapper.vm.activeFilters.folderDepth = 1
    await flushPromises()
    expect(
      wrapper.vm.nodes
        .filter((n) => !n.synthetic)
        .map((n) => n.path)
        .sort()
    ).toEqual(['docs/child', 'docs/child/grandchild'])
  })

  it('tag/locale filters still narrow on top of the anchor restriction', async () => {
    const graph = {
      nodes: ANCHOR_TREE_GRAPH.nodes.map((n) =>
        n.path === 'docs/child/grandchild' ? { ...n, tags: ['special'] } : n
      ),
      edges: []
    }
    const wrapper = await mountGraph({
      graph,
      initialPath: '/_graph?path=docs/child',
      pageLocale: 'en'
    })

    wrapper.vm.activeFilters.tags = ['special']
    await flushPromises()

    expect(wrapper.vm.nodes.filter((n) => !n.synthetic).map((n) => n.path)).toEqual([
      'docs/child/grandchild'
    ])
  })

  it('a root-anchored ?path= (the home page) leaves the whole locale visible, unrestricted', async () => {
    const graph = {
      nodes: [{ path: '', locale: 'en', title: 'Home', icon: null, tags: [], folder: '' }].concat(
        ANCHOR_TREE_GRAPH.nodes
      ),
      edges: []
    }
    const wrapper = await mountGraph({ graph, initialPath: '/_graph?path=', pageLocale: 'en' })

    // -> An empty `?path=` resolves to nothing (`resolveFocusNode`'s own falsy-path no-op), so this
    //    exercises the same "no anchor" path as no query param at all.
    const realPaths = wrapper.vm.nodes.filter((node) => !node.synthetic)
    expect(realPaths).toHaveLength(graph.nodes.length)
  })

  it('a root-anchored ?path= resolves the synthetic root node as the anchor and highlights it on the canvas (OpenProject #3490)', async () => {
    const wrapper = await mountGraph({
      graph: ANCHOR_TREE_GRAPH,
      initialPath: '/_graph?path=',
      pageLocale: 'en'
    })

    expect(wrapper.vm.routeFocusAnchor).toEqual({ path: '', locale: 'en' })
    expect(wrapper.vm.focusNodeId).toBe('en:')
    expect(wrapper.vm.highlightedNodeIds.has('en:')).toBe(true)
    expect(wrapper.vm.nodes.find((node) => node.root)).toMatchObject({ path: '', locale: 'en' })
  })

  it('a page selected before entry stays ringed under a folder anchor and under the root anchor (OpenProject #3490)', async () => {
    const underFolder = await mountGraph({
      graph: ANCHOR_TREE_GRAPH,
      initialPath: '/_graph?path=docs',
      pageLocale: 'en',
      graphSelectedPath: 'docs/child'
    })
    expect(underFolder.vm.selectedNodeId).toBe('en:docs/child')

    const underRoot = await mountGraph({
      graph: ANCHOR_TREE_GRAPH,
      initialPath: '/_graph?path=',
      pageLocale: 'en',
      graphSelectedPath: 'about'
    })
    expect(underRoot.vm.selectedNodeId).toBe('en:about')
  })

  it('watch(focusNodeId, ...) re-runs the anchor restriction reactively, not only at mount', async () => {
    const wrapper = await mountGraph({ graph: ANCHOR_TREE_GRAPH })

    expect(wrapper.vm.nodes.filter((n) => !n.synthetic)).toHaveLength(
      ANCHOR_TREE_GRAPH.nodes.length
    )

    // -> Both refs are assigned, because `applyRouteFocus()` sets them together on a re-navigation;
    //    what is under test is that the `focusNodeId` change alone re-runs the restriction.
    wrapper.vm.routeFocusAnchor = { path: 'docs/child', locale: 'en' }
    wrapper.vm.focusNodeId = 'en:docs/child'
    await flushPromises()

    const realPaths = wrapper.vm.nodes
      .filter((node) => !node.synthetic)
      .map((node) => node.path)
      .sort()
    expect(realPaths).toEqual(['docs/child', 'docs/child/grandchild'])
  })
})
