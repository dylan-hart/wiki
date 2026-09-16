import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'

import { mountGraph } from './graphFixtures.js'

/*
 * OpenProject #3333 (Feature #3311's own follow-up scope correction to Task #3312, which explicitly
 * scoped this out): once `/_graph?path=` resolves to a NON-ROOT anchor, the rendered graph is
 * restricted to that anchor plus its descendants -- not the whole filtered graph, as Task #3312
 * originally shipped. `activeFilters.folderDepth` is reinterpreted alongside it, as hops-from-the-
 * anchor instead of path-segments-from-the-site-root. `Graph.route.test.js` covers the ?path=
 * resolution/centering/highlighting mechanics themselves; this suite covers the restriction those
 * mechanics now feed, plus `Graph.vue`'s own `watch(focusNodeId, applyFilters)` (this WP's own
 * responsibility per this round's epic-plan note #9742) that keeps it reactive to a later anchor
 * change rather than only the initial mount-time resolution.
 */

// docs -> docs/child -> docs/child/grandchild, plus an unrelated sibling tree ('blog') and an
// unrelated root-level page ('about') -- enough shape to exercise ancestor/sibling/descendant
// exclusion and the depth-from-anchor reinterpretation together.
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
    // -> Every other test in this file asserts only against `!node.synthetic` real paths -- which is
    //    exactly how this bug shipped unnoticed: `buildPathHierarchyEdges()` used to climb every
    //    already-restricted real node's full ancestor chain regardless of the anchor, re-synthesizing
    //    root (and any intermediate ancestor) straight back into `nodes.value`. 'docs/child' sits two
    //    segments deep, so a pre-fix run would have leaked BOTH '' (root) and 'docs' here.
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
    //    exercises the same "no anchor" path as no query param at all -- included here as an explicit
    //    guard that a root/home anchor was never meant to narrow anything, matching
    //    `graphFilters.test.js`'s "root anchor is unrestricted" unit coverage for the underlying
    //    function.
    const realPaths = wrapper.vm.nodes.filter((node) => !node.synthetic)
    expect(realPaths).toHaveLength(graph.nodes.length)
  })

  it('watch(focusNodeId, ...) re-runs the anchor restriction reactively, not only at mount', async () => {
    const wrapper = await mountGraph({ graph: ANCHOR_TREE_GRAPH })

    // -> Before any anchor: the full graph renders, matching the "no ?path=" case above.
    expect(wrapper.vm.nodes.filter((n) => !n.synthetic)).toHaveLength(
      ANCHOR_TREE_GRAPH.nodes.length
    )

    // -> Simulates what a later re-navigation (this round's sibling Bug fixing the missing
    //    `route.query.path` watcher, and #3334's live sidebar-click re-homing) will eventually drive
    //    through `applyRouteFocus()` re-running: both outputs it assigns together changing at once.
    //    This WP's own responsibility is only that a `focusNodeId` change alone is enough to re-run
    //    the restriction -- see this watch's own doc comment in `Graph.vue`.
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
