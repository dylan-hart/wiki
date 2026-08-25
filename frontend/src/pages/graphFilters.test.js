import { describe, expect, it } from 'vitest'
import {
  buildClassificationHubEdges,
  buildPathHierarchyEdges,
  buildTagHubEdges,
  computeVisibleSubset,
  deriveFilterOptions
} from './graphFilters.js'

const NODES = [
  { id: 'en:a', path: 'a', locale: 'en', tags: ['foo', 'bar'] },
  { id: 'fr:b', path: 'b', locale: 'fr', tags: ['foo'] },
  { id: 'en:c', path: 'c', locale: 'en', tags: [] }
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
  { id: 'en:a', path: 'a', locale: 'en', tags: ['foo'], folder: '' },
  { id: 'fr:docs/b', path: 'docs/b', locale: 'fr', tags: ['bar'], folder: 'docs' },
  { id: 'en:docs/deep/c', path: 'docs/deep/c', locale: 'en', tags: [], folder: 'docs' }
]
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

  // -> OpenProject #1621/#1632: translations share `path` by design, so filtering to one locale must
  //    drop an edge whose target exists only in the OTHER locale, not keep it alive because a
  //    same-path node in the filtered-out locale still occupies that path.
  describe('same-path translations (OpenProject #1621)', () => {
    const enIntro = { id: 'en:docs/intro', path: 'docs/intro', locale: 'en', tags: [] }
    const frIntro = { id: 'fr:docs/intro', path: 'docs/intro', locale: 'fr', tags: [] }
    const enHome = { id: 'en:home', path: 'home', locale: 'en', tags: [] }
    const twoLocaleNodes = [enHome, enIntro, frIntro]
    // -> `en:home` links to `docs/intro`, but ONLY the `fr` copy exists as a link target here --
    //    matches the backend fixture in `graph.test.ts`'s own same-path-translations case.
    const twoLocaleEdges = [{ source: 'en:home', target: 'fr:docs/intro', type: 'link' }]

    it('keeps both same-path translations as distinct visible nodes with no locale filter', () => {
      const { visibleNodes } = computeVisibleSubset(twoLocaleNodes, twoLocaleEdges, {
        tags: [],
        folderDepth: null,
        locale: null
      })
      expect(visibleNodes.map((n) => n.id).sort()).toEqual([
        'en:docs/intro',
        'en:home',
        'fr:docs/intro'
      ])
    })

    it('under a single-locale filter, drops an edge whose target exists only in the other locale', () => {
      const { visibleNodes, visibleEdges } = computeVisibleSubset(twoLocaleNodes, twoLocaleEdges, {
        tags: [],
        folderDepth: null,
        locale: 'en'
      })
      expect(visibleNodes.map((n) => n.id)).toEqual(['en:home', 'en:docs/intro'])
      // -> The edge's target (`fr:docs/intro`) is not among the en-only visible ids, even though an
      //    `en:docs/intro` node exists at the same PATH -- a bare-path Set would have wrongly kept
      //    this edge alive.
      expect(visibleEdges).toEqual([])
    })
  })
})

describe('buildPathHierarchyEdges (OpenProject #998)', () => {
  it('climbs a nested path to a synthetic root, synthesizing every missing segment', () => {
    const { syntheticNodes, edges } = buildPathHierarchyEdges([
      { id: 'en:docs/child/page', path: 'docs/child/page', locale: 'en' }
    ])
    expect(syntheticNodes.map((n) => n.id).sort()).toEqual(['en:', 'en:docs', 'en:docs/child'])
    expect(edges).toEqual([
      { source: 'en:docs/child', target: 'en:docs/child/page', type: 'path' },
      { source: 'en:docs', target: 'en:docs/child', type: 'path' },
      { source: 'en:', target: 'en:docs', type: 'path' }
    ])
  })

  it('gives a root-level page a single edge straight to the synthetic root', () => {
    const { syntheticNodes, edges } = buildPathHierarchyEdges([
      { id: 'en:about', path: 'about', locale: 'en' }
    ])
    expect(syntheticNodes).toEqual([
      { id: 'en:', path: '', locale: 'en', title: '(root)', synthetic: true }
    ])
    expect(edges).toEqual([{ source: 'en:', target: 'en:about', type: 'path' }])
  })

  it('de-dupes the shared parent edge for sibling pages under the same folder', () => {
    const { syntheticNodes, edges } = buildPathHierarchyEdges([
      { id: 'en:docs/a', path: 'docs/a', locale: 'en' },
      { id: 'en:docs/b', path: 'docs/b', locale: 'en' }
    ])
    expect(syntheticNodes.map((n) => n.id).sort()).toEqual(['en:', 'en:docs'])
    expect(edges).toEqual([
      { source: 'en:docs', target: 'en:docs/a', type: 'path' },
      { source: 'en:', target: 'en:docs', type: 'path' },
      { source: 'en:docs', target: 'en:docs/b', type: 'path' }
    ])
  })

  it('reuses a real page as its own folder node instead of synthesizing a duplicate', () => {
    const { syntheticNodes, edges } = buildPathHierarchyEdges([
      { id: 'en:docs', path: 'docs', locale: 'en', title: 'Docs Index' },
      { id: 'en:docs/child', path: 'docs/child', locale: 'en' }
    ])
    expect(syntheticNodes).toEqual([
      { id: 'en:', path: '', locale: 'en', title: '(root)', synthetic: true }
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
      { id: 'en:', path: '', locale: 'en', title: 'Home' },
      { id: 'en:about', path: 'about', locale: 'en' }
    ])
    expect(syntheticNodes).toEqual([])
    expect(edges).toEqual([{ source: 'en:', target: 'en:about', type: 'path' }])
  })

  it('produces nothing for an empty node set', () => {
    expect(buildPathHierarchyEdges([])).toEqual({ syntheticNodes: [], edges: [] })
  })

  // -> OpenProject #1621/#1632: translations share `path` by design, so two locales' pages must
  //    climb to two SEPARATE, locale-qualified hierarchies rather than merging into one tree keyed
  //    on the bare path.
  it('produces a separate hierarchy per locale rather than one merged tree', () => {
    const { syntheticNodes, edges } = buildPathHierarchyEdges([
      { id: 'en:docs/intro', path: 'docs/intro', locale: 'en' },
      { id: 'fr:docs/intro', path: 'docs/intro', locale: 'fr' }
    ])
    expect(syntheticNodes.map((n) => n.id).sort()).toEqual(['en:', 'en:docs', 'fr:', 'fr:docs'])
    expect(edges).toEqual(
      expect.arrayContaining([
        { source: 'en:docs', target: 'en:docs/intro', type: 'path' },
        { source: 'en:', target: 'en:docs', type: 'path' },
        { source: 'fr:docs', target: 'fr:docs/intro', type: 'path' },
        { source: 'fr:', target: 'fr:docs', type: 'path' }
      ])
    )
    expect(edges).toHaveLength(4)
  })
})

describe('buildTagHubEdges (OpenProject #999)', () => {
  it('creates one hub per distinct tag, with an edge from the hub to each carrying page', () => {
    const { syntheticNodes, edges } = buildTagHubEdges([
      { id: 'en:a', path: 'a', tags: ['foo'] },
      { id: 'en:b', path: 'b', tags: ['bar'] }
    ])
    expect(syntheticNodes).toEqual([
      { id: '__tag__foo', path: '__tag__foo', title: 'foo', synthetic: true },
      { id: '__tag__bar', path: '__tag__bar', title: 'bar', synthetic: true }
    ])
    expect(edges).toEqual([
      { source: '__tag__foo', target: 'en:a', type: 'tag' },
      { source: '__tag__bar', target: 'en:b', type: 'tag' }
    ])
  })

  it('gives a multi-tagged page one edge per tag, not just its first', () => {
    const { edges } = buildTagHubEdges([{ id: 'en:a', path: 'a', tags: ['foo', 'bar'] }])
    expect(edges).toEqual([
      { source: '__tag__foo', target: 'en:a', type: 'tag' },
      { source: '__tag__bar', target: 'en:a', type: 'tag' }
    ])
  })

  it('shares one hub node across every page carrying the same tag', () => {
    const { syntheticNodes, edges } = buildTagHubEdges([
      { id: 'en:a', path: 'a', tags: ['foo'] },
      { id: 'en:b', path: 'b', tags: ['foo'] }
    ])
    expect(syntheticNodes).toEqual([
      { id: '__tag__foo', path: '__tag__foo', title: 'foo', synthetic: true }
    ])
    expect(edges).toEqual([
      { source: '__tag__foo', target: 'en:a', type: 'tag' },
      { source: '__tag__foo', target: 'en:b', type: 'tag' }
    ])
  })

  it('produces no hubs or edges for an untagged page', () => {
    const { syntheticNodes, edges } = buildTagHubEdges([{ id: 'en:a', path: 'a', tags: [] }])
    expect(syntheticNodes).toEqual([])
    expect(edges).toEqual([])
  })

  it('treats a missing tags array the same as an empty one', () => {
    const { syntheticNodes, edges } = buildTagHubEdges([{ id: 'en:a', path: 'a' }])
    expect(syntheticNodes).toEqual([])
    expect(edges).toEqual([])
  })

  // -> OpenProject #1621/#1632: a same-path `en`/`fr` pair must produce two distinct edge targets,
  //    not both wire to whichever one a path-keyed lookup happened to keep.
  it('wires a same-path translation pair to two distinct edge targets', () => {
    const { edges } = buildTagHubEdges([
      { id: 'en:docs/intro', path: 'docs/intro', locale: 'en', tags: ['guide'] },
      { id: 'fr:docs/intro', path: 'docs/intro', locale: 'fr', tags: ['guide'] }
    ])
    expect(edges).toEqual([
      { source: '__tag__guide', target: 'en:docs/intro', type: 'tag' },
      { source: '__tag__guide', target: 'fr:docs/intro', type: 'tag' }
    ])
  })
})

describe('buildPathHierarchyEdges: combined scenario (OpenProject #1002)', () => {
  it('produces exactly one synthetic node per distinct missing folder and one edge per parent-child pair, across a mixed real/synthetic tree', () => {
    const nodes = [
      { id: 'en:docs', path: 'docs', locale: 'en', title: 'Docs Index' }, // real page reused as its own folder node
      { id: 'en:docs/guides/intro', path: 'docs/guides/intro', locale: 'en' },
      { id: 'en:docs/guides/advanced', path: 'docs/guides/advanced', locale: 'en' },
      { id: 'en:about', path: 'about', locale: 'en' }
    ]
    const { syntheticNodes, edges } = buildPathHierarchyEdges(nodes)

    expect(syntheticNodes.map((n) => n.id).sort()).toEqual(['en:', 'en:docs/guides'])
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
      { id: 'en:a', path: 'a', tags: ['guide', 'beginner'] },
      { id: 'en:b', path: 'b', tags: ['guide'] },
      { id: 'en:c', path: 'c', tags: ['beginner', 'reference'] },
      { id: 'en:d', path: 'd', tags: [] }
    ]
    const { syntheticNodes, edges } = buildTagHubEdges(nodes)

    expect(syntheticNodes.map((n) => n.id).sort()).toEqual([
      '__tag__beginner',
      '__tag__guide',
      '__tag__reference'
    ])
    expect(edges).toHaveLength(5)
    expect(edges).toEqual(
      expect.arrayContaining([
        { source: '__tag__guide', target: 'en:a', type: 'tag' },
        { source: '__tag__beginner', target: 'en:a', type: 'tag' },
        { source: '__tag__guide', target: 'en:b', type: 'tag' },
        { source: '__tag__beginner', target: 'en:c', type: 'tag' },
        { source: '__tag__reference', target: 'en:c', type: 'tag' }
      ])
    )
  })
})

describe('buildClassificationHubEdges (OpenProject #1217)', () => {
  it('creates one hub per distinct classification, with an edge from the hub to each carrying page', () => {
    const { syntheticNodes, edges } = buildClassificationHubEdges([
      { id: 'en:a', path: 'a', classification: 'Public' },
      { id: 'en:b', path: 'b', classification: 'Restricted' }
    ])
    expect(syntheticNodes).toEqual([
      {
        id: '__classification__Public',
        path: '__classification__Public',
        title: 'Public',
        synthetic: true
      },
      {
        id: '__classification__Restricted',
        path: '__classification__Restricted',
        title: 'Restricted',
        synthetic: true
      }
    ])
    expect(edges).toEqual([
      { source: '__classification__Public', target: 'en:a', type: 'classification' },
      { source: '__classification__Restricted', target: 'en:b', type: 'classification' }
    ])
  })

  it('shares one hub node across every page carrying the same classification', () => {
    const { syntheticNodes, edges } = buildClassificationHubEdges([
      { id: 'en:a', path: 'a', classification: 'Public' },
      { id: 'en:b', path: 'b', classification: 'Public' }
    ])
    expect(syntheticNodes).toEqual([
      {
        id: '__classification__Public',
        path: '__classification__Public',
        title: 'Public',
        synthetic: true
      }
    ])
    expect(edges).toEqual([
      { source: '__classification__Public', target: 'en:a', type: 'classification' },
      { source: '__classification__Public', target: 'en:b', type: 'classification' }
    ])
  })

  it('groups a node with no resolved classification under a shared (unclassified) hub', () => {
    const { syntheticNodes, edges } = buildClassificationHubEdges([
      { id: 'en:a', path: 'a', classification: null },
      { id: 'en:b', path: 'b' }
    ])
    expect(syntheticNodes).toEqual([
      {
        id: '__classification__(unclassified)',
        path: '__classification__(unclassified)',
        title: '(unclassified)',
        synthetic: true
      }
    ])
    expect(edges).toEqual([
      { source: '__classification__(unclassified)', target: 'en:a', type: 'classification' },
      { source: '__classification__(unclassified)', target: 'en:b', type: 'classification' }
    ])
  })

  it('produces nothing for an empty node set', () => {
    expect(buildClassificationHubEdges([])).toEqual({ syntheticNodes: [], edges: [] })
  })

  // -> OpenProject #1621/#1632: a same-path `en`/`fr` pair must produce two distinct edge targets.
  it('wires a same-path translation pair to two distinct edge targets', () => {
    const { edges } = buildClassificationHubEdges([
      { id: 'en:docs/intro', path: 'docs/intro', locale: 'en', classification: 'Public' },
      { id: 'fr:docs/intro', path: 'docs/intro', locale: 'fr', classification: 'Public' }
    ])
    expect(edges).toEqual([
      { source: '__classification__Public', target: 'en:docs/intro', type: 'classification' },
      { source: '__classification__Public', target: 'fr:docs/intro', type: 'classification' }
    ])
  })
})
