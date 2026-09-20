import { describe, expect, it } from 'vitest'

import { mountGraph } from './graphFixtures.js'

/*
 * Grouping that buckets off the site root while the rendered set is restricted to a deeper anchor
 * hands every visible node the same level-1 key, so they all paint one color: folder-mode grouping
 * has to restart at the anchor's own children.
 */

// 'docs' as the anchor, with a page directly in it and no further subfolder -- enough shape for
// level-1 anchor-relative bucketing (guides vs reference vs the anchor's own '(root)' bucket) and
// for level-2 nesting relative to the anchor.
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
    //    '(root)' bucket, the same fallback an un-anchored top-level page gets.
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
    // -> One segment beyond the anchor ('reference') is not deep enough for a level-2 key.
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

    // -> Two segments beyond the anchor, so the circle it is a MEMBER of is the anchor-relative top
    //    folder 'guides', same as any real page directly in 'docs/guides'.
    const guidesSubFolder = wrapper.vm.nodes.find(
      (node) => node.synthetic && node.path === 'docs/guides/sub'
    )
    // -> One segment beyond the anchor, so its parent IS the anchor, which has no anchor-relative
    //    folder key of its own and therefore falls into '(root)'.
    const guidesFolder = wrapper.vm.nodes.find(
      (node) => node.synthetic && node.path === 'docs/guides'
    )
    expect(guidesSubFolder).toBeTruthy()
    expect(guidesFolder).toBeTruthy()
    expect(wrapper.vm.parentGroupKeyFor(guidesSubFolder)).toBe('guides')
    expect(wrapper.vm.parentGroupKeyFor(guidesFolder)).toBe('(root)')
  })
})
