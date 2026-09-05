import { describe, expect, it } from 'vitest'
import {
  buildPathHierarchyEdges,
  computeHighlightedNodeIds,
  computeTitleMatchNodeIds,
  computeVisibleSubset,
  deriveFilterOptions,
  deriveMaxFolderDepth,
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

describe('MAX_DEPTH (OpenProject #2514/#2520)', () => {
  it('mirrors backend/models/tree.ts#MAX_DEPTH', () => {
    expect(MAX_DEPTH).toBe(10)
  })
})

describe('deriveMaxFolderDepth (OpenProject #2514/#2520)', () => {
  it('returns 0 for an empty node set', () => {
    expect(deriveMaxFolderDepth([])).toBe(0)
  })

  it('returns 0 when every node is root-level (no "/" in its path)', () => {
    expect(deriveMaxFolderDepth([{ path: 'a' }, { path: 'standalone' }])).toBe(0)
  })

  it('returns the deepest folder actually present across the node set', () => {
    const nodes = [{ path: 'a' }, { path: 'guides/one' }, { path: 'guides/deep/two' }]
    expect(deriveMaxFolderDepth(nodes)).toBe(2)
  })

  it('is not thrown off by which node happens to come first', () => {
    const nodes = [{ path: 'guides/deep/two' }, { path: 'guides/one' }, { path: 'a' }]
    expect(deriveMaxFolderDepth(nodes)).toBe(2)
  })

  it('caps at MAX_DEPTH for a graph deeper than the reasonable ceiling', () => {
    const deepPath = Array.from({ length: MAX_DEPTH + 5 }, (_, i) => `level${i}`).join('/')
    expect(deriveMaxFolderDepth([{ path: deepPath }])).toBe(MAX_DEPTH)
  })

  it('reports exactly MAX_DEPTH when a graph is precisely that deep, not off by one', () => {
    // -> Depth is segment count minus 1 (`folderDepthOf`), so MAX_DEPTH segments after the first
    //    means MAX_DEPTH + 1 total path segments.
    const exactPath = Array.from({ length: MAX_DEPTH + 1 }, (_, i) => `level${i}`).join('/')
    expect(deriveMaxFolderDepth([{ path: exactPath }])).toBe(MAX_DEPTH)
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

describe('computeTitleMatchNodeIds (OpenProject #2533)', () => {
  const TITLED_NODES = [
    { path: 'guides/onboarding', locale: 'en', title: 'Onboarding Guide' },
    { path: 'guides/onboarding', locale: 'fr', title: 'Guide d’intégration' },
    { path: 'reference/api', locale: 'en', title: 'API Reference' }
  ]

  it('matches a node whose title contains the query as a plain substring', () => {
    const ids = computeTitleMatchNodeIds(TITLED_NODES, 'onboard')
    expect(ids).toEqual(new Set(['en:guides/onboarding']))
  })

  it('is case-insensitive', () => {
    const ids = computeTitleMatchNodeIds(TITLED_NODES, 'ONBOARD')
    expect(ids).toEqual(new Set(['en:guides/onboarding']))
  })

  it('matches every node whose title contains the query, across locales', () => {
    const ids = computeTitleMatchNodeIds(TITLED_NODES, 'api')
    // -> 'API Reference' matches directly; 'guides/onboarding' doesn't contain 'api' in either
    //    locale's title, so only the one real match comes back.
    expect(ids).toEqual(new Set(['en:reference/api']))
  })

  it('returns an empty Set for an empty, whitespace-only, null or undefined query', () => {
    expect(computeTitleMatchNodeIds(TITLED_NODES, '')).toEqual(new Set())
    expect(computeTitleMatchNodeIds(TITLED_NODES, '   ')).toEqual(new Set())
    expect(computeTitleMatchNodeIds(TITLED_NODES, null)).toEqual(new Set())
    expect(computeTitleMatchNodeIds(TITLED_NODES, undefined)).toEqual(new Set())
  })

  it('returns an empty Set when nothing matches, without throwing', () => {
    expect(computeTitleMatchNodeIds(TITLED_NODES, 'nonexistent-keyword')).toEqual(new Set())
  })

  it('returns an empty Set for an empty, null or undefined node list', () => {
    expect(computeTitleMatchNodeIds([], 'api')).toEqual(new Set())
    expect(computeTitleMatchNodeIds(null, 'api')).toEqual(new Set())
    expect(computeTitleMatchNodeIds(undefined, 'api')).toEqual(new Set())
  })

  it('never matches a node with no title (synthetic hub nodes carry none)', () => {
    const nodes = [{ path: '__tag__foo', synthetic: true }]
    expect(computeTitleMatchNodeIds(nodes, 'foo')).toEqual(new Set())
  })

  it('trims the query before matching, same as searchKeyword’s own watcher', () => {
    const ids = computeTitleMatchNodeIds(TITLED_NODES, '  onboard  ')
    expect(ids).toEqual(new Set(['en:guides/onboarding']))
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

  it('marks only the root ("") synthetic node with root: true (OpenProject #2563)', () => {
    const { syntheticNodes } = buildPathHierarchyEdges([{ path: 'docs/child/page', locale: 'en' }])

    const root = syntheticNodes.find((n) => n.path === '')
    const nonRoots = syntheticNodes.filter((n) => n.path !== '')

    expect(root.root).toBe(true)
    // -> Every other synthetic folder node has no `root` key at all -- not `root: false` -- so a
    //    plain `for...in`/`Object.keys` scan over a non-root node never even sees the key.
    expect(nonRoots).toHaveLength(2)
    for (const node of nonRoots) {
      expect('root' in node).toBe(false)
    }
  })

  it('gives a root-level page a single edge straight to the synthetic root', () => {
    const { syntheticNodes, edges } = buildPathHierarchyEdges([{ path: 'about', locale: 'en' }])
    expect(syntheticNodes).toEqual([
      { path: '', locale: 'en', title: '(root)', synthetic: true, root: true }
    ])
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
    expect(syntheticNodes).toEqual([
      { path: '', locale: 'en', title: '(root)', synthetic: true, root: true }
    ])
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
        { path: '', locale: 'en', title: '(root)', synthetic: true, root: true },
        { path: 'docs', locale: 'en', title: 'docs', synthetic: true },
        { path: '', locale: 'fr', title: '(root)', synthetic: true, root: true },
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
        { path: '', locale: 'en', title: '(root)', synthetic: true, root: true },
        { path: '', locale: 'fr', title: '(root)', synthetic: true, root: true },
        { path: 'docs', locale: 'fr', title: 'docs', synthetic: true }
      ])
    )
    // 'docs' is NOT synthesized for `en` -- the real Docs Index page is reused instead.
    expect(syntheticNodes.some((n) => n.locale === 'en' && n.path === 'docs')).toBe(false)
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

describe('synthetic node identity cache (OpenProject #2538)', () => {
  it('buildPathHierarchyEdges reuses the same folder/root node object across two calls sharing a cache', () => {
    const nodes = [{ path: 'docs/guide', locale: 'en' }]
    const cache = new Map()

    const first = buildPathHierarchyEdges(nodes, cache)
    const second = buildPathHierarchyEdges(nodes, cache)

    const firstByPath = new Map(first.syntheticNodes.map((n) => [n.path, n]))
    const secondByPath = new Map(second.syntheticNodes.map((n) => [n.path, n]))
    expect(firstByPath.get('docs')).toBe(secondByPath.get('docs'))
    expect(firstByPath.get('')).toBe(secondByPath.get(''))
  })

  it('buildPathHierarchyEdges hands d3-force whatever position was assigned to a cached node', () => {
    const cache = new Map()
    const { syntheticNodes } = buildPathHierarchyEdges(
      [{ path: 'docs/guide', locale: 'en' }],
      cache
    )
    const folderNode = syntheticNodes.find((n) => n.path === 'docs')
    folderNode.x = 123
    folderNode.y = 456

    const { syntheticNodes: reSynced } = buildPathHierarchyEdges(
      [{ path: 'docs/guide', locale: 'en' }],
      cache
    )
    expect(reSynced.find((n) => n.path === 'docs')).toMatchObject({ x: 123, y: 456 })
  })

  it('buildPathHierarchyEdges gives a genuinely new folder no cached position, without disturbing prior entries', () => {
    const cache = new Map()
    buildPathHierarchyEdges([{ path: 'docs/guide', locale: 'en' }], cache)
    const { syntheticNodes } = buildPathHierarchyEdges(
      [
        { path: 'docs/guide', locale: 'en' },
        { path: 'blog/post', locale: 'en' }
      ],
      cache
    )
    expect(syntheticNodes.find((n) => n.path === 'blog')).not.toHaveProperty('x')
  })

  it('buildPathHierarchyEdges defaults to a fresh cache when none is given, matching prior no-reuse behavior', () => {
    const nodes = [{ path: 'docs/guide', locale: 'en' }]
    const first = buildPathHierarchyEdges(nodes)
    const second = buildPathHierarchyEdges(nodes)
    const firstDocs = first.syntheticNodes.find((n) => n.path === 'docs')
    const secondDocs = second.syntheticNodes.find((n) => n.path === 'docs')
    expect(firstDocs).not.toBe(secondDocs)
    expect(firstDocs).toEqual(secondDocs)
  })
})
