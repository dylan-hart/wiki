import { describe, expect, it } from 'vitest'
import {
  buildPathHierarchyEdges,
  buildTagHubEdges,
  computeVisibleSubset,
  deriveFilterOptions
} from './graphFilters.js'

const NODES = [
  { path: 'a', locale: 'en', tags: ['foo', 'bar'] },
  { path: 'b', locale: 'fr', tags: ['foo'] },
  { path: 'c', locale: 'en', tags: [] }
]

describe('deriveFilterOptions (OpenProject #899)', () => {
  it('collects every distinct tag across all nodes, sorted', () => {
    const { tags } = deriveFilterOptions(NODES)
    expect(tags).toEqual(['bar', 'foo'])
  })

  it('collects every distinct locale across all nodes, sorted', () => {
    const { locales } = deriveFilterOptions(NODES)
    expect(locales).toEqual(['en', 'fr'])
  })

  it('returns empty arrays for an empty node set', () => {
    expect(deriveFilterOptions([])).toEqual({ tags: [], locales: [] })
  })
})

// Paths are deliberately nested at different depths (unlike `folder`, which the backend keeps to a
// single segment for Feature 874's clustering) -- the depth filter derives depth from `path`, so the
// fixture needs real multi-level paths to exercise that (OpenProject #898/#900).
const NODES2 = [
  { path: 'a', locale: 'en', tags: ['foo'], folder: '' },
  { path: 'docs/b', locale: 'fr', tags: ['bar'], folder: 'docs' },
  { path: 'docs/deep/c', locale: 'en', tags: [], folder: 'docs' }
]
const EDGES2 = [
  { source: 'a', target: 'docs/b', type: 'link' },
  { source: 'a', target: 'docs/deep/c', type: 'link' }
]

describe('computeVisibleSubset (OpenProject #900)', () => {
  it('with no active filters, everything is visible', () => {
    const { visibleNodes, visibleEdges } = computeVisibleSubset(NODES2, EDGES2, {
      tags: [],
      folderDepth: null,
      locale: null
    })
    expect(visibleNodes.map((n) => n.path)).toEqual(['a', 'docs/b', 'docs/deep/c'])
    expect(visibleEdges).toHaveLength(2)
  })

  it('filters by tag', () => {
    const { visibleNodes } = computeVisibleSubset(NODES2, EDGES2, {
      tags: ['foo'],
      folderDepth: null,
      locale: null
    })
    expect(visibleNodes.map((n) => n.path)).toEqual(['a'])
  })

  it('filters by locale', () => {
    const { visibleNodes } = computeVisibleSubset(NODES2, EDGES2, {
      tags: [],
      folderDepth: null,
      locale: 'fr'
    })
    expect(visibleNodes.map((n) => n.path)).toEqual(['docs/b'])
  })

  it('filters by folder depth (path segment count, not node.folder)', () => {
    const { visibleNodes } = computeVisibleSubset(NODES2, EDGES2, {
      tags: [],
      folderDepth: 1,
      locale: null
    })
    // 'a' is depth 0, 'docs/b' is depth 1, 'docs/deep/c' is depth 2 -- only the latter is excluded.
    expect(visibleNodes.map((n) => n.path)).toEqual(['a', 'docs/b'])
  })

  it('depth 0 is a real, active filter -- distinct from no filter at all (OpenProject #898)', () => {
    const withDepthZero = computeVisibleSubset(NODES2, EDGES2, {
      tags: [],
      folderDepth: 0,
      locale: null
    })
    const withNoFilter = computeVisibleSubset(NODES2, EDGES2, {
      tags: [],
      folderDepth: null,
      locale: null
    })
    expect(withDepthZero.visibleNodes.map((n) => n.path)).toEqual(['a'])
    expect(withNoFilter.visibleNodes.map((n) => n.path)).toEqual(['a', 'docs/b', 'docs/deep/c'])
  })

  it('produces a genuinely different visible set at each depth value on multi-level paths', () => {
    const depth0 = computeVisibleSubset(NODES2, EDGES2, { tags: [], folderDepth: 0, locale: null })
    const depth1 = computeVisibleSubset(NODES2, EDGES2, { tags: [], folderDepth: 1, locale: null })
    const depth2 = computeVisibleSubset(NODES2, EDGES2, { tags: [], folderDepth: 2, locale: null })
    expect(depth0.visibleNodes.map((n) => n.path)).toEqual(['a'])
    expect(depth1.visibleNodes.map((n) => n.path)).toEqual(['a', 'docs/b'])
    expect(depth2.visibleNodes.map((n) => n.path)).toEqual(['a', 'docs/b', 'docs/deep/c'])
  })

  it('drops an edge when either endpoint is filtered out', () => {
    const { visibleEdges } = computeVisibleSubset(NODES2, EDGES2, {
      tags: ['foo'],
      folderDepth: null,
      locale: null
    })
    expect(visibleEdges).toEqual([])
  })

  it('ANDs multiple active filters', () => {
    const { visibleNodes } = computeVisibleSubset(NODES2, EDGES2, {
      tags: ['foo'],
      folderDepth: null,
      locale: 'en'
    })
    expect(visibleNodes.map((n) => n.path)).toEqual(['a'])
  })

  it('matches edges whose endpoints have already been resolved to node objects by d3-force', () => {
    const nodeA = NODES2[0]
    const nodeB = NODES2[1]
    const resolvedEdges = [{ source: nodeA, target: nodeB, type: 'link' }]
    const { visibleEdges } = computeVisibleSubset(NODES2, resolvedEdges, {
      tags: [],
      folderDepth: null,
      locale: null
    })
    expect(visibleEdges).toEqual(resolvedEdges)
  })
})

describe('buildPathHierarchyEdges (OpenProject #998)', () => {
  it('climbs a nested path to a synthetic root, synthesizing every missing segment', () => {
    const { syntheticNodes, edges } = buildPathHierarchyEdges([{ path: 'docs/child/page' }])
    expect(syntheticNodes.map((n) => n.path).sort()).toEqual(['', 'docs', 'docs/child'])
    expect(edges).toEqual([
      { source: 'docs/child', target: 'docs/child/page', type: 'path' },
      { source: 'docs', target: 'docs/child', type: 'path' },
      { source: '', target: 'docs', type: 'path' }
    ])
  })

  it('gives a root-level page a single edge straight to the synthetic root', () => {
    const { syntheticNodes, edges } = buildPathHierarchyEdges([{ path: 'about' }])
    expect(syntheticNodes).toEqual([{ path: '', title: '(root)', synthetic: true }])
    expect(edges).toEqual([{ source: '', target: 'about', type: 'path' }])
  })

  it('de-dupes the shared parent edge for sibling pages under the same folder', () => {
    const { syntheticNodes, edges } = buildPathHierarchyEdges([
      { path: 'docs/a' },
      { path: 'docs/b' }
    ])
    expect(syntheticNodes.map((n) => n.path).sort()).toEqual(['', 'docs'])
    expect(edges).toEqual([
      { source: 'docs', target: 'docs/a', type: 'path' },
      { source: '', target: 'docs', type: 'path' },
      { source: 'docs', target: 'docs/b', type: 'path' }
    ])
  })

  it('reuses a real page as its own folder node instead of synthesizing a duplicate', () => {
    const { syntheticNodes, edges } = buildPathHierarchyEdges([
      { path: 'docs', title: 'Docs Index' },
      { path: 'docs/child' }
    ])
    expect(syntheticNodes).toEqual([{ path: '', title: '(root)', synthetic: true }])
    expect(edges).toHaveLength(2)
    expect(edges).toEqual(
      expect.arrayContaining([
        { source: 'docs', target: 'docs/child', type: 'path' },
        { source: '', target: 'docs', type: 'path' }
      ])
    )
  })

  it('reuses a real home page (path "") as the root instead of synthesizing one', () => {
    const { syntheticNodes, edges } = buildPathHierarchyEdges([
      { path: '', title: 'Home' },
      { path: 'about' }
    ])
    expect(syntheticNodes).toEqual([])
    expect(edges).toEqual([{ source: '', target: 'about', type: 'path' }])
  })

  it('produces nothing for an empty node set', () => {
    expect(buildPathHierarchyEdges([])).toEqual({ syntheticNodes: [], edges: [] })
  })
})

describe('buildTagHubEdges (OpenProject #999)', () => {
  it('creates one hub per distinct tag, with an edge from the hub to each carrying page', () => {
    const { syntheticNodes, edges } = buildTagHubEdges([
      { path: 'a', tags: ['foo'] },
      { path: 'b', tags: ['bar'] }
    ])
    expect(syntheticNodes).toEqual([
      { path: '__tag__foo', title: 'foo', synthetic: true },
      { path: '__tag__bar', title: 'bar', synthetic: true }
    ])
    expect(edges).toEqual([
      { source: '__tag__foo', target: 'a', type: 'tag' },
      { source: '__tag__bar', target: 'b', type: 'tag' }
    ])
  })

  it('gives a multi-tagged page one edge per tag, not just its first', () => {
    const { edges } = buildTagHubEdges([{ path: 'a', tags: ['foo', 'bar'] }])
    expect(edges).toEqual([
      { source: '__tag__foo', target: 'a', type: 'tag' },
      { source: '__tag__bar', target: 'a', type: 'tag' }
    ])
  })

  it('shares one hub node across every page carrying the same tag', () => {
    const { syntheticNodes, edges } = buildTagHubEdges([
      { path: 'a', tags: ['foo'] },
      { path: 'b', tags: ['foo'] }
    ])
    expect(syntheticNodes).toEqual([{ path: '__tag__foo', title: 'foo', synthetic: true }])
    expect(edges).toEqual([
      { source: '__tag__foo', target: 'a', type: 'tag' },
      { source: '__tag__foo', target: 'b', type: 'tag' }
    ])
  })

  it('produces no hubs or edges for an untagged page', () => {
    const { syntheticNodes, edges } = buildTagHubEdges([{ path: 'a', tags: [] }])
    expect(syntheticNodes).toEqual([])
    expect(edges).toEqual([])
  })

  it('treats a missing tags array the same as an empty one', () => {
    const { syntheticNodes, edges } = buildTagHubEdges([{ path: 'a' }])
    expect(syntheticNodes).toEqual([])
    expect(edges).toEqual([])
  })
})

describe('buildPathHierarchyEdges: combined scenario (OpenProject #1002)', () => {
  it('produces exactly one synthetic node per distinct missing folder and one edge per parent-child pair, across a mixed real/synthetic tree', () => {
    const nodes = [
      { path: 'docs', title: 'Docs Index' }, // real page reused as its own folder node
      { path: 'docs/guides/intro' },
      { path: 'docs/guides/advanced' },
      { path: 'about' }
    ]
    const { syntheticNodes, edges } = buildPathHierarchyEdges(nodes)

    expect(syntheticNodes.map((n) => n.path).sort()).toEqual(['', 'docs/guides'])
    expect(edges).toEqual(
      expect.arrayContaining([
        { source: 'docs/guides', target: 'docs/guides/intro', type: 'path' },
        { source: 'docs', target: 'docs/guides', type: 'path' },
        { source: 'docs/guides', target: 'docs/guides/advanced', type: 'path' },
        { source: '', target: 'docs', type: 'path' },
        { source: '', target: 'about', type: 'path' }
      ])
    )
    // -> One edge per distinct parent-child pair, no more: 4 real pages climbing a shared tree
    //    produce exactly 5 edges once the shared `docs -> docs/guides` and `'' -> docs` legs are
    //    de-duped across every page that climbs through them.
    expect(edges).toHaveLength(5)
  })
})

describe('buildTagHubEdges: combined scenario (OpenProject #1002)', () => {
  it('produces exactly one hub per distinct tag and one edge per (page, tag) pair, across shared and multi-tagged pages', () => {
    const nodes = [
      { path: 'a', tags: ['guide', 'beginner'] },
      { path: 'b', tags: ['guide'] },
      { path: 'c', tags: ['beginner', 'reference'] },
      { path: 'd', tags: [] }
    ]
    const { syntheticNodes, edges } = buildTagHubEdges(nodes)

    expect(syntheticNodes.map((n) => n.path).sort()).toEqual([
      '__tag__beginner',
      '__tag__guide',
      '__tag__reference'
    ])
    expect(edges).toHaveLength(5)
    expect(edges).toEqual(
      expect.arrayContaining([
        { source: '__tag__guide', target: 'a', type: 'tag' },
        { source: '__tag__beginner', target: 'a', type: 'tag' },
        { source: '__tag__guide', target: 'b', type: 'tag' },
        { source: '__tag__beginner', target: 'c', type: 'tag' },
        { source: '__tag__reference', target: 'c', type: 'tag' }
      ])
    )
  })
})
