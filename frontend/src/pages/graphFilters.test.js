import { describe, expect, it } from 'vitest'
import {
  buildClassificationHubEdges,
  buildPathHierarchyEdges,
  buildTagHubEdges,
  computeHighlightedNodeIds,
  computeVisibleSubset,
  deriveFilterOptions,
  deriveMaxFolderDepth,
  folderDepthOf,
  MAX_DEPTH,
  nodeId
} from './graphFilters.js'

const NODES = [
  { path: 'a', locale: 'en', tags: ['foo', 'bar'] },
  { path: 'b', locale: 'fr', tags: ['foo'] },
  { path: 'c', locale: 'en', tags: [] }
]

describe('nodeId (OpenProject #1629/#1632)', () => {
  it('keys a real node (one with a locale) on the composite `${locale}:${path}`', () => {
    expect(nodeId({ path: 'docs/intro', locale: 'en' })).toBe('en:docs/intro')
    expect(nodeId({ path: 'docs/intro', locale: 'fr' })).toBe('fr:docs/intro')
  })

  it('gives two locales of the same path two distinct ids', () => {
    const en = nodeId({ path: 'docs/intro', locale: 'en' })
    const fr = nodeId({ path: 'docs/intro', locale: 'fr' })
    expect(en).not.toBe(fr)
  })

  it('keeps a synthetic node (no locale) on its already-unique bare path', () => {
    expect(nodeId({ path: '__tag__foo', synthetic: true })).toBe('__tag__foo')
    expect(nodeId({ path: '', synthetic: true })).toBe('')
  })
})

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

describe('computeHighlightedNodeIds (OpenProject #2480)', () => {
  it('turns keyword search matches into the composite locale:path ids nodeId() computes', () => {
    const ids = computeHighlightedNodeIds([
      { path: 'docs/intro', locale: 'en' },
      { path: 'docs/deep/c', locale: 'en' }
    ])
    expect(ids).toEqual(new Set(['en:docs/intro', 'en:docs/deep/c']))
  })

  it('keeps two locales of the same path as two distinct ids, same as nodeId() itself', () => {
    const ids = computeHighlightedNodeIds([
      { path: 'docs/intro', locale: 'en' },
      { path: 'docs/intro', locale: 'fr' }
    ])
    expect(ids).toEqual(new Set(['en:docs/intro', 'fr:docs/intro']))
  })

  it('returns an empty Set for no matches, an empty array, null or undefined alike', () => {
    expect(computeHighlightedNodeIds([])).toEqual(new Set())
    expect(computeHighlightedNodeIds(null)).toEqual(new Set())
    expect(computeHighlightedNodeIds(undefined)).toEqual(new Set())
  })

  it('de-duplicates a match repeated across results into one id', () => {
    const ids = computeHighlightedNodeIds([
      { path: 'docs/intro', locale: 'en' },
      { path: 'docs/intro', locale: 'en' }
    ])
    expect(ids).toEqual(new Set(['en:docs/intro']))
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
// Sources/targets are composite `${locale}:${path}` ids, matching what the graph API emits
// (OpenProject #1626) and what `computeVisibleSubset` now keys visibility by (OpenProject #1632).
const EDGES2 = [
  { source: 'en:a', target: 'fr:docs/b', type: 'link' },
  { source: 'en:a', target: 'en:docs/deep/c', type: 'link' }
]

describe('folderDepthOf / deriveMaxFolderDepth (OpenProject #2520/#2521)', () => {
  it('reads the number of directory segments in a path, not node.folder', () => {
    expect(folderDepthOf({ path: 'a', folder: '' })).toBe(0)
    expect(folderDepthOf({ path: 'docs/b', folder: 'docs' })).toBe(1)
    expect(folderDepthOf({ path: 'docs/deep/c', folder: 'docs' })).toBe(2)
  })

  it('returns the deepest folderDepthOf() among the given nodes', () => {
    expect(deriveMaxFolderDepth(NODES2)).toBe(2)
  })

  it('returns 0 for an empty node set -- the pre-load `allNodes` state', () => {
    expect(deriveMaxFolderDepth([])).toBe(0)
  })

  it("is not itself capped at MAX_DEPTH -- capping is the caller's job", () => {
    const deepNodes = [{ path: Array.from({ length: MAX_DEPTH + 5 }, (_, i) => `s${i}`).join('/') }]
    expect(deriveMaxFolderDepth(deepNodes)).toBe(MAX_DEPTH + 4)
  })

  it('mirrors backend/models/tree.ts MAX_DEPTH', () => {
    expect(MAX_DEPTH).toBe(10)
  })
})

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

  it('drops an edge whose target exists only in the other locale, even though a same-path node in the active locale survives the filter (OpenProject #1632)', () => {
    const nodes = [
      { path: 'a', locale: 'en', tags: [] },
      { path: 'shared', locale: 'en', tags: [] },
      { path: 'shared', locale: 'fr', tags: [] }
    ]
    // The edge's real target is the `fr` copy of 'shared' -- bare-path matching would have wrongly
    // kept this edge once the `en` copy of 'shared' also passed the filter.
    const edges = [{ source: 'en:a', target: 'fr:shared', type: 'link' }]

    const { visibleNodes, visibleEdges } = computeVisibleSubset(nodes, edges, {
      tags: [],
      folderDepth: null,
      locale: 'en'
    })
    expect(visibleNodes.map((n) => n.path)).toEqual(['a', 'shared'])
    expect(visibleEdges).toEqual([])
  })
})

describe('buildPathHierarchyEdges (OpenProject #998)', () => {
  it('climbs a nested path to a synthetic root, synthesizing every missing segment', () => {
    const { syntheticNodes, edges } = buildPathHierarchyEdges([
      { path: 'docs/child/page', locale: 'en' }
    ])
    expect(syntheticNodes.map((n) => n.path).sort()).toEqual(['', 'docs', 'docs/child'])
    expect(edges).toEqual([
      { source: 'en:docs/child', target: 'en:docs/child/page', type: 'path' },
      { source: 'en:docs', target: 'en:docs/child', type: 'path' },
      { source: 'en:', target: 'en:docs', type: 'path' }
    ])
  })

  it('gives a root-level page a single edge straight to the synthetic root', () => {
    const { syntheticNodes, edges } = buildPathHierarchyEdges([{ path: 'about', locale: 'en' }])
    expect(syntheticNodes).toEqual([{ path: '', locale: 'en', title: '(root)', synthetic: true }])
    expect(edges).toEqual([{ source: 'en:', target: 'en:about', type: 'path' }])
  })

  it('de-dupes the shared parent edge for sibling pages under the same folder', () => {
    const { syntheticNodes, edges } = buildPathHierarchyEdges([
      { path: 'docs/a', locale: 'en' },
      { path: 'docs/b', locale: 'en' }
    ])
    expect(syntheticNodes.map((n) => n.path).sort()).toEqual(['', 'docs'])
    expect(edges).toEqual([
      { source: 'en:docs', target: 'en:docs/a', type: 'path' },
      { source: 'en:', target: 'en:docs', type: 'path' },
      { source: 'en:docs', target: 'en:docs/b', type: 'path' }
    ])
  })

  it('reuses a real page as its own folder node instead of synthesizing a duplicate', () => {
    const { syntheticNodes, edges } = buildPathHierarchyEdges([
      { path: 'docs', title: 'Docs Index', locale: 'en' },
      { path: 'docs/child', locale: 'en' }
    ])
    expect(syntheticNodes).toEqual([{ path: '', locale: 'en', title: '(root)', synthetic: true }])
    expect(edges).toHaveLength(2)
    expect(edges).toEqual(
      expect.arrayContaining([
        { source: 'en:docs', target: 'en:docs/child', type: 'path' },
        { source: 'en:', target: 'en:docs', type: 'path' }
      ])
    )
  })

  it('reuses a real home page (path "") as the root instead of synthesizing one', () => {
    const { syntheticNodes, edges } = buildPathHierarchyEdges([
      { path: '', title: 'Home', locale: 'en' },
      { path: 'about', locale: 'en' }
    ])
    expect(syntheticNodes).toEqual([])
    expect(edges).toEqual([{ source: 'en:', target: 'en:about', type: 'path' }])
  })

  it('produces nothing for an empty node set', () => {
    expect(buildPathHierarchyEdges([])).toEqual({ syntheticNodes: [], edges: [] })
  })

  it('gives two locales of the same leaf path their own distinct, separately-addressed edges (OpenProject #1629/#1632)', () => {
    const { syntheticNodes, edges } = buildPathHierarchyEdges([
      { path: 'docs/intro', locale: 'en' },
      { path: 'docs/intro', locale: 'fr' }
    ])
    // -> Each locale climbs its OWN folder chain (composite-id ids throughout, OpenProject #1632),
    //    so neither the synthetic 'docs' node nor the leaf edge's target collides across locales.
    expect(syntheticNodes.map((n) => n.path).sort()).toEqual(['', '', 'docs', 'docs'])
    expect(edges).toEqual(
      expect.arrayContaining([
        { source: 'en:docs', target: 'en:docs/intro', type: 'path' },
        { source: 'fr:docs', target: 'fr:docs/intro', type: 'path' },
        { source: 'en:', target: 'en:docs', type: 'path' },
        { source: 'fr:', target: 'fr:docs', type: 'path' }
      ])
    )
    expect(edges).toHaveLength(4)
  })
})

describe('buildPathHierarchyEdges: locale-qualified hierarchy (OpenProject #1632)', () => {
  it('builds a separate hierarchy per locale instead of merging same-path trees', () => {
    const nodes = [
      { path: 'docs/child', locale: 'en' },
      { path: 'docs/child', locale: 'fr' }
    ]
    const { syntheticNodes, edges } = buildPathHierarchyEdges(nodes)

    // One root and one 'docs' folder node per locale -- not one shared pair merging both trees.
    expect(syntheticNodes).toHaveLength(4)
    expect(syntheticNodes).toEqual(
      expect.arrayContaining([
        { path: '', locale: 'en', title: '(root)', synthetic: true },
        { path: 'docs', locale: 'en', title: 'docs', synthetic: true },
        { path: '', locale: 'fr', title: '(root)', synthetic: true },
        { path: 'docs', locale: 'fr', title: 'docs', synthetic: true }
      ])
    )

    expect(edges).toHaveLength(4)
    expect(edges).toEqual(
      expect.arrayContaining([
        { source: 'en:docs', target: 'en:docs/child', type: 'path' },
        { source: 'en:', target: 'en:docs', type: 'path' },
        { source: 'fr:docs', target: 'fr:docs/child', type: 'path' },
        { source: 'fr:', target: 'fr:docs', type: 'path' }
      ])
    )
  })

  it('a real page in one locale does not suppress synthesizing the same folder path in another locale', () => {
    // A real page sits at path 'docs' in `en`; `fr`'s 'docs' has no real page at all -- the two
    // locales must not share one `byId` lookup that decides whether to synthesize it.
    const nodes = [
      { path: 'docs', title: 'Docs Index', locale: 'en' },
      { path: 'docs/child', locale: 'en' },
      { path: 'docs/child', locale: 'fr' }
    ]
    const { syntheticNodes } = buildPathHierarchyEdges(nodes)

    expect(syntheticNodes).toEqual(
      expect.arrayContaining([
        { path: '', locale: 'en', title: '(root)', synthetic: true },
        { path: '', locale: 'fr', title: '(root)', synthetic: true },
        { path: 'docs', locale: 'fr', title: 'docs', synthetic: true }
      ])
    )
    // 'docs' is NOT synthesized for `en` -- the real Docs Index page is reused instead.
    expect(syntheticNodes.some((n) => n.locale === 'en' && n.path === 'docs')).toBe(false)
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

  it('gives two locales of the same path sharing a tag two distinct edges (OpenProject #1629/#1632)', () => {
    const { syntheticNodes, edges } = buildTagHubEdges([
      { path: 'a', locale: 'en', tags: ['foo'] },
      { path: 'a', locale: 'fr', tags: ['foo'] }
    ])
    expect(syntheticNodes).toEqual([{ path: '__tag__foo', title: 'foo', synthetic: true }])
    expect(edges).toEqual([
      { source: '__tag__foo', target: 'en:a', type: 'tag' },
      { source: '__tag__foo', target: 'fr:a', type: 'tag' }
    ])
  })
})

describe('buildPathHierarchyEdges: combined scenario (OpenProject #1002)', () => {
  it('produces exactly one synthetic node per distinct missing folder and one edge per parent-child pair, across a mixed real/synthetic tree', () => {
    const nodes = [
      { path: 'docs', title: 'Docs Index', locale: 'en' }, // real page reused as its own folder node
      { path: 'docs/guides/intro', locale: 'en' },
      { path: 'docs/guides/advanced', locale: 'en' },
      { path: 'about', locale: 'en' }
    ]
    const { syntheticNodes, edges } = buildPathHierarchyEdges(nodes)

    expect(syntheticNodes.map((n) => n.path).sort()).toEqual(['', 'docs/guides'])
    expect(edges).toEqual(
      expect.arrayContaining([
        { source: 'en:docs/guides', target: 'en:docs/guides/intro', type: 'path' },
        { source: 'en:docs', target: 'en:docs/guides', type: 'path' },
        { source: 'en:docs/guides', target: 'en:docs/guides/advanced', type: 'path' },
        { source: 'en:', target: 'en:docs', type: 'path' },
        { source: 'en:', target: 'en:about', type: 'path' }
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

describe('buildClassificationHubEdges (OpenProject #1217)', () => {
  it('creates one hub per distinct classification, with an edge from the hub to each carrying page', () => {
    const { syntheticNodes, edges } = buildClassificationHubEdges([
      { path: 'a', classification: 'Public' },
      { path: 'b', classification: 'Restricted' }
    ])
    expect(syntheticNodes).toEqual([
      { path: '__classification__Public', title: 'Public', synthetic: true },
      { path: '__classification__Restricted', title: 'Restricted', synthetic: true }
    ])
    expect(edges).toEqual([
      { source: '__classification__Public', target: 'a', type: 'classification' },
      { source: '__classification__Restricted', target: 'b', type: 'classification' }
    ])
  })

  it('shares one hub node across every page carrying the same classification', () => {
    const { syntheticNodes, edges } = buildClassificationHubEdges([
      { path: 'a', classification: 'Public' },
      { path: 'b', classification: 'Public' }
    ])
    expect(syntheticNodes).toEqual([
      { path: '__classification__Public', title: 'Public', synthetic: true }
    ])
    expect(edges).toEqual([
      { source: '__classification__Public', target: 'a', type: 'classification' },
      { source: '__classification__Public', target: 'b', type: 'classification' }
    ])
  })

  it('groups a node with no resolved classification under a shared (unclassified) hub', () => {
    const { syntheticNodes, edges } = buildClassificationHubEdges([
      { path: 'a', classification: null },
      { path: 'b' }
    ])
    expect(syntheticNodes).toEqual([
      { path: '__classification__(unclassified)', title: '(unclassified)', synthetic: true }
    ])
    expect(edges).toEqual([
      { source: '__classification__(unclassified)', target: 'a', type: 'classification' },
      { source: '__classification__(unclassified)', target: 'b', type: 'classification' }
    ])
  })

  it('produces nothing for an empty node set', () => {
    expect(buildClassificationHubEdges([])).toEqual({ syntheticNodes: [], edges: [] })
  })

  it('gives two locales of the same path sharing a classification two distinct edges (OpenProject #1629/#1632)', () => {
    const { syntheticNodes, edges } = buildClassificationHubEdges([
      { path: 'a', locale: 'en', classification: 'Public' },
      { path: 'a', locale: 'fr', classification: 'Public' }
    ])
    expect(syntheticNodes).toEqual([
      { path: '__classification__Public', title: 'Public', synthetic: true }
    ])
    expect(edges).toEqual([
      { source: '__classification__Public', target: 'en:a', type: 'classification' },
      { source: '__classification__Public', target: 'fr:a', type: 'classification' }
    ])
  })
})
