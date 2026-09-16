import { describe, expect, it } from 'vitest'

import { mountGraph } from './graphFixtures.js'

/*
 * OpenProject #3372: folder-mode color/cluster grouping used to always bucket off the site ROOT's
 * own top-level folders, even while `Graph.vue` was anchored (`?path=`, OpenProject #3333) to some
 * deeper folder and the rendered node set was already restricted to that anchor plus its
 * descendants (`Graph.anchor.test.js`). That mismatch read as broken color coding: every node
 * visible on screen shared the anchor's own single ancestor folder, so `groupKeyFor()` handed every
 * one of them the SAME level-1 key and they all painted one color, with none of the anchor's own
 * child folders visually distinguished from each other.
 *
 * These assert `groupKeyFor()`/`parentGroupKeyFor()` (and the `node.color` they drive via
 * `recomputeClusters()`) restart their folder-mode grouping at the anchor's own children instead --
 * a page directly in one of the anchor's child folders groups (and colors) by THAT child folder, not
 * by the anchor's own ancestor. A root anchor, or no anchor at all, must still group from the true
 * site root exactly as before (`Graph.anchor.test.js`'s own "root anchor is a no-op" invariant,
 * mirrored here for grouping).
 */

// docs (anchor) -> docs/guides/sub/{one,two} and docs/reference/api, plus a page directly in docs
// with no further subfolder at all -- enough shape to exercise level-1 anchor-relative bucketing
// (guides vs reference vs the anchor's own direct '(root)' bucket) and level-2 nesting relative to
// the anchor (docs/guides/sub/one and .../two share a level-2 key, docs/reference/api does not).
const ANCHOR_GROUPING_GRAPH = {
  nodes: [
    { path: 'docs', locale: 'en', title: 'Docs', icon: null, tags: [], folder: '' },
    { path: 'docs/index', locale: 'en', title: 'Docs Index', icon: null, tags: [], folder: 'docs' },
    {
      path: 'docs/guides/sub/one',
      locale: 'en',
      title: 'Guide One',
      icon: null,
      tags: [],
      folder: 'docs'
    },
    {
      path: 'docs/guides/sub/two',
      locale: 'en',
      title: 'Guide Two',
      icon: null,
      tags: [],
      folder: 'docs'
    },
    {
      path: 'docs/reference/api',
      locale: 'en',
      title: 'API Reference',
      icon: null,
      tags: [],
      folder: 'docs'
    },
    { path: 'blog', locale: 'en', title: 'Blog', icon: null, tags: [], folder: '' },
    { path: 'blog/post', locale: 'en', title: 'Post', icon: null, tags: [], folder: 'blog' }
  ],
  edges: []
}

describe('Graph.vue folder-mode grouping stays in sync with the current anchor (OpenProject #3372)', () => {
  it('groups a direct child of the anchor by that child folder, not by the anchor itself', async () => {
    const wrapper = await mountGraph({
      graph: ANCHOR_GROUPING_GRAPH,
      initialPath: '/_graph?path=docs',
      pageLocale: 'en'
    })

    const guideOne = wrapper.vm.nodes.find((node) => node.path === 'docs/guides/sub/one')
    const guideTwo = wrapper.vm.nodes.find((node) => node.path === 'docs/guides/sub/two')
    const apiRef = wrapper.vm.nodes.find((node) => node.path === 'docs/reference/api')
    const docsIndex = wrapper.vm.nodes.find((node) => node.path === 'docs/index')

    expect(wrapper.vm.groupKeyFor(guideOne)).toBe('guides')
    expect(wrapper.vm.groupKeyFor(guideTwo)).toBe('guides')
    expect(wrapper.vm.groupKeyFor(apiRef)).toBe('reference')
    // -> A page directly under the anchor with no further subfolder falls into the anchor-relative
    //    '(root)' bucket -- the same fallback an un-anchored top-level page always got, just
    //    relative to the anchor instead of the true site root.
    expect(wrapper.vm.groupKeyFor(docsIndex)).toBe('(root)')
  })

  it('gives siblings under different anchor-relative folders different colors once recomputed', async () => {
    const wrapper = await mountGraph({
      graph: ANCHOR_GROUPING_GRAPH,
      initialPath: '/_graph?path=docs',
      pageLocale: 'en'
    })
    wrapper.vm.recomputeClusters()

    const guideOne = wrapper.vm.nodes.find((node) => node.path === 'docs/guides/sub/one')
    const apiRef = wrapper.vm.nodes.find((node) => node.path === 'docs/reference/api')

    expect(guideOne.color).not.toBe(apiRef.color)
  })

  it('nests level-2 grouping relative to the anchor -- two nodes under the same anchor-relative subfolder share it', async () => {
    const wrapper = await mountGraph({
      graph: ANCHOR_GROUPING_GRAPH,
      initialPath: '/_graph?path=docs',
      pageLocale: 'en'
    })

    const guideOne = wrapper.vm.nodes.find((node) => node.path === 'docs/guides/sub/one')
    const guideTwo = wrapper.vm.nodes.find((node) => node.path === 'docs/guides/sub/two')
    const apiRef = wrapper.vm.nodes.find((node) => node.path === 'docs/reference/api')

    expect(wrapper.vm.groupKeyFor(guideOne, 2)).toBe('guides/sub')
    expect(wrapper.vm.groupKeyFor(guideTwo, 2)).toBe('guides/sub')
    // -> `docs/reference/api` has only ONE segment beyond the anchor ('reference') -- not deep
    //    enough for a level-2 key, same as a real page directly at the site root always was.
    expect(wrapper.vm.groupKeyFor(apiRef, 2)).toBeNull()
    // -> Neither guide node has a THIRD segment beyond the anchor -- level 3 is not reachable.
    expect(wrapper.vm.groupKeyFor(guideOne, 3)).toBeNull()
  })

  it('groups exactly as before (from the true site root) with no anchor active', async () => {
    const wrapper = await mountGraph({ graph: ANCHOR_GROUPING_GRAPH, initialPath: '/_graph' })

    const guideOne = wrapper.vm.nodes.find((node) => node.path === 'docs/guides/sub/one')
    const blogPost = wrapper.vm.nodes.find((node) => node.path === 'blog/post')

    expect(wrapper.vm.groupKeyFor(guideOne)).toBe('docs')
    expect(wrapper.vm.groupKeyFor(blogPost)).toBe('blog')
  })

  it('groups exactly as before (from the true site root) while anchored at the root itself', async () => {
    // -> A root anchor (`path: ''`) is documented elsewhere (Graph.anchor.test.js) to behave
    //    identically to no anchor at all -- this is the same invariant, asserted for grouping.
    const wrapper = await mountGraph({
      graph: ANCHOR_GROUPING_GRAPH,
      initialPath: '/_graph?path=',
      pageLocale: 'en'
    })

    const guideOne = wrapper.vm.nodes.find((node) => node.path === 'docs/guides/sub/one')
    expect(wrapper.vm.groupKeyFor(guideOne)).toBe('docs')
  })

  it('anchor-relatively memberships a nested synthetic folder node into its anchor-relative top folder circle (OpenProject #3355)', async () => {
    const wrapper = await mountGraph({
      graph: ANCHOR_GROUPING_GRAPH,
      initialPath: '/_graph?path=docs',
      pageLocale: 'en'
    })

    // -> `docs/guides/sub` is a synthetic folder hub two segments beyond the anchor ('docs') --
    //    its PARENT circle (the one it's a MEMBER of) is the anchor-relative top folder 'guides',
    //    same as any real page directly in 'docs/guides' would be.
    const guidesSubFolder = wrapper.vm.nodes.find(
      (node) => node.synthetic && node.path === 'docs/guides/sub'
    )
    // -> `docs/guides` itself is only ONE segment beyond the anchor -- its own parent IS the
    //    anchor, which has no anchor-relative folder key of its own, so it falls into '(root)'.
    const guidesFolder = wrapper.vm.nodes.find(
      (node) => node.synthetic && node.path === 'docs/guides'
    )
    expect(guidesSubFolder).toBeTruthy()
    expect(guidesFolder).toBeTruthy()
    expect(wrapper.vm.parentGroupKeyFor(guidesSubFolder)).toBe('guides')
    expect(wrapper.vm.parentGroupKeyFor(guidesFolder)).toBe('(root)')
  })
})
