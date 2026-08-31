import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { assembleGraph, folderOf, GRAPH_NODE_CAP, type GraphPageRow } from './graph.ts'

function makeRow(overrides: Partial<GraphPageRow> = {}): GraphPageRow {
  // -> `id` defaults to `path` (not a fixed constant) so a test giving several rows distinct
  //    `path`s for free also gets them distinct `id`s, without every call site having to say so.
  const path = overrides.path ?? 'docs/intro'
  return {
    id: path,
    path,
    locale: 'en',
    title: 'Intro',
    icon: null,
    tags: [],
    classification: 'level-public',
    relations: [],
    links: [],
    ...overrides
  }
}

describe('folderOf', () => {
  test('takes the first path segment', () => {
    assert.equal(folderOf('docs/child/page'), 'docs')
  })

  test('is the whole path for a root-level page', () => {
    assert.equal(folderOf('about'), 'about')
  })

  test('is empty for the home page (path "")', () => {
    assert.equal(folderOf(''), '')
  })
})

describe('assembleGraph', () => {
  test('includes only nodes canRead allows', () => {
    const rows = [makeRow({ path: 'a' }), makeRow({ path: 'b' })]

    const result = assembleGraph(rows, (row) => row.path === 'a')

    assert.deepEqual(
      result.nodes.map((n) => n.path),
      ['a']
    )
  })

  test('derives folder on each node', () => {
    const rows = [makeRow({ path: 'docs/child/page' })]

    const result = assembleGraph(rows, () => true)

    assert.equal(result.nodes[0]!.folder, 'docs')
  })

  test('builds a relation edge between two visible pages, carrying its label', () => {
    const rows = [
      makeRow({
        path: 'a',
        relations: [{ pos: 'left', label: 'See also', caption: '', icon: '', target: 'b' }]
      }),
      makeRow({ path: 'b' })
    ]

    const result = assembleGraph(rows, () => true)

    assert.deepEqual(result.edges, [
      { source: 'a', target: 'b', type: 'relation', label: 'See also' }
    ])
  })

  test('builds a link edge between two visible pages, unlabeled', () => {
    const rows = [makeRow({ path: 'a', links: ['b'] }), makeRow({ path: 'b' })]

    const result = assembleGraph(rows, () => true)

    assert.deepEqual(result.edges, [{ source: 'a', target: 'b', type: 'link' }])
  })

  test('drops a relation edge whose target is not readable', () => {
    const rows = [
      makeRow({
        path: 'a',
        relations: [{ pos: 'left', label: '', caption: '', icon: '', target: 'secret' }]
      }),
      makeRow({ path: 'secret' })
    ]

    const result = assembleGraph(rows, (row) => row.path !== 'secret')

    assert.deepEqual(result.edges, [])
  })

  test('drops a link edge whose source page is not readable', () => {
    const rows = [makeRow({ path: 'a', links: ['b'] }), makeRow({ path: 'b' })]

    const result = assembleGraph(rows, (row) => row.path !== 'a')

    assert.deepEqual(result.edges, [])
    assert.deepEqual(
      result.nodes.map((n) => n.path),
      ['b']
    )
  })

  // -> OpenProject #1126: a CLASSIFICATION rule must be able to hide a page from the graph, the same
  //    way it already hides it from direct view, search and the sitemap. `canRead` here stands in
  //    for `mayOnPage()`, which resolves a CLASSIFICATION DENY against `row.classification` -- so
  //    this only holds if `classification` actually reaches the predicate on every row.
  test("canRead sees each row's classification, so a CLASSIFICATION-based DENY can hide it", () => {
    const rows = [
      makeRow({ path: 'open', classification: 'level-public' }),
      makeRow({ path: 'secret', classification: 'level-restricted' })
    ]

    const result = assembleGraph(rows, (row) => row.classification !== 'level-restricted')

    assert.deepEqual(
      result.nodes.map((n) => n.path),
      ['open']
    )
  })

  // -> OpenProject #1217: node.classification is the resolved display name, not the raw id --
  //    `classificationName` stands in for `WIKI.models.classificationLevels.byId(id)?.name`.
  test("resolves each node's classification id through the classificationName accessor", () => {
    const rows = [makeRow({ path: 'a', classification: 'level-restricted' })]

    const result = assembleGraph(
      rows,
      () => true,
      (id) => (id === 'level-restricted' ? 'Restricted' : null)
    )

    assert.equal(result.nodes[0]!.classification, 'Restricted')
  })

  test('classification id passes through unresolved when no classificationName accessor is given', () => {
    const rows = [makeRow({ path: 'a', classification: 'level-restricted' })]

    const result = assembleGraph(rows, () => true)

    assert.equal(result.nodes[0]!.classification, 'level-restricted')
  })

  test('a classification id with no matching level resolves to null', () => {
    const rows = [makeRow({ path: 'a', classification: 'stale-id' })]

    const result = assembleGraph(
      rows,
      () => true,
      () => null
    )

    assert.equal(result.nodes[0]!.classification, null)
  })

  const ZERO_TOTAL_CONTRIBUTORS = { editor: 0, mcp: 0, all: 0 }

  // -> OpenProject #1141: node.contributors is the resolved edit-volume counts, not looked up by
  //    the test itself -- `contributorsFor` stands in for `pageHistory.contributorCountsForGraph()`.
  test("resolves each node's contributor counts through the contributorsFor accessor, keyed by id", () => {
    const rows = [makeRow({ path: 'a', id: 'page-a' }), makeRow({ path: 'b', id: 'page-b' })]
    const pageAContributors = { editor: 3, mcp: 1, all: 4, total: { editor: 5, mcp: 2, all: 7 } }
    const zeroContributors = { editor: 0, mcp: 0, all: 0, total: ZERO_TOTAL_CONTRIBUTORS }

    const result = assembleGraph(
      rows,
      () => true,
      undefined,
      (pageId) => (pageId === 'page-a' ? pageAContributors : zeroContributors)
    )

    assert.deepEqual(result.nodes.find((n) => n.path === 'a')!.contributors, pageAContributors)
    assert.deepEqual(result.nodes.find((n) => n.path === 'b')!.contributors, zeroContributors)
  })

  test('contributors default to all-zero when no contributorsFor accessor is given', () => {
    const rows = [makeRow({ path: 'a' })]

    const result = assembleGraph(rows, () => true)

    assert.deepEqual(result.nodes[0]!.contributors, {
      editor: 0,
      mcp: 0,
      all: 0,
      total: ZERO_TOTAL_CONTRIBUTORS
    })
  })

  const ZERO_TOTAL_PAGEVIEW_WINDOW = { browser: 0, api: 0, mcp: 0, all: 0 }
  const ZERO_PAGEVIEW_WINDOW = {
    browser: 0,
    api: 0,
    mcp: 0,
    all: 0,
    total: ZERO_TOTAL_PAGEVIEW_WINDOW
  }
  const ZERO_PAGEVIEWS = {
    last30d: ZERO_PAGEVIEW_WINDOW,
    last6mo: ZERO_PAGEVIEW_WINDOW,
    last2yr: ZERO_PAGEVIEW_WINDOW
  }

  // -> OpenProject #1140: node.pageviews is the resolved page-visit-volume counts, not looked up by
  //    the test itself -- `pageviewsFor` stands in for `pageviews.countsForGraph()`.
  test("resolves each node's pageview counts through the pageviewsFor accessor, keyed by id", () => {
    const rows = [makeRow({ path: 'a', id: 'page-a' }), makeRow({ path: 'b', id: 'page-b' })]
    const pageAViews = {
      last30d: {
        browser: 5,
        api: 2,
        mcp: 0,
        all: 7,
        total: { browser: 9, api: 3, mcp: 0, all: 12 }
      },
      last6mo: {
        browser: 20,
        api: 8,
        mcp: 1,
        all: 29,
        total: { browser: 40, api: 15, mcp: 2, all: 57 }
      },
      last2yr: {
        browser: 50,
        api: 10,
        mcp: 3,
        all: 63,
        total: { browser: 80, api: 18, mcp: 5, all: 103 }
      }
    }

    const result = assembleGraph(
      rows,
      () => true,
      undefined,
      undefined,
      (pageId) => (pageId === 'page-a' ? pageAViews : ZERO_PAGEVIEWS)
    )

    assert.deepEqual(result.nodes.find((n) => n.path === 'a')!.pageviews, pageAViews)
    assert.deepEqual(result.nodes.find((n) => n.path === 'b')!.pageviews, ZERO_PAGEVIEWS)
  })

  test('pageviews default to all-zero across every window when no pageviewsFor accessor is given', () => {
    const rows = [makeRow({ path: 'a' })]

    const result = assembleGraph(rows, () => true)

    assert.deepEqual(result.nodes[0]!.pageviews, ZERO_PAGEVIEWS)
  })
})

// -> OpenProject #1866: the node cap, and the truncated/totalNodes signal that lets a client tell
//    the reader a graph view is partial rather than silently attempting a layout it cannot finish.
describe('assembleGraph node cap', () => {
  /** `n` rows with zero-padded paths, so lexicographic order (what the cap sorts by) matches
   *  numeric order -- makes "which rows survive" trivial to assert on. */
  function makeManyRows(n: number): GraphPageRow[] {
    return Array.from({ length: n }, (_, i) => makeRow({ path: `p${String(i).padStart(6, '0')}` }))
  }

  test('an under-cap site is not truncated, and totalNodes equals nodes.length', () => {
    const rows = makeManyRows(3)

    const result = assembleGraph(rows, () => true)

    assert.equal(result.truncated, false)
    assert.equal(result.totalNodes, result.nodes.length)
    assert.equal(result.totalNodes, 3)
  })

  test('an over-cap site is truncated to exactly the cap, reporting the true totalNodes', () => {
    const rows = makeManyRows(GRAPH_NODE_CAP + 137)

    const result = assembleGraph(rows, () => true)

    assert.equal(result.truncated, true)
    assert.equal(result.nodes.length, GRAPH_NODE_CAP)
    assert.equal(result.totalNodes, GRAPH_NODE_CAP + 137)
  })

  test('the cap only counts readable rows -- totalNodes reflects canRead, not the raw row count', () => {
    const rows = makeManyRows(GRAPH_NODE_CAP + 50)

    const result = assembleGraph(
      rows,
      (row) => row.path < `p${String(GRAPH_NODE_CAP).padStart(6, '0')}`
    )

    assert.equal(result.truncated, false)
    assert.equal(result.totalNodes, GRAPH_NODE_CAP)
    assert.equal(result.nodes.length, GRAPH_NODE_CAP)
  })

  test('selection is deterministic (sorted by path), not raw row order', () => {
    const ordered = makeManyRows(GRAPH_NODE_CAP + 10)
    const shuffled = [...ordered].reverse()

    const fromOrdered = assembleGraph(ordered, () => true)
    const fromShuffled = assembleGraph(shuffled, () => true)

    assert.deepEqual(
      fromOrdered.nodes.map((n) => n.path),
      fromShuffled.nodes.map((n) => n.path)
    )
    // -> The lexicographically-first GRAPH_NODE_CAP paths, specifically -- not just "some stable
    //    subset". Confirms the sort key is `path`, not e.g. insertion order surviving a stable sort.
    assert.deepEqual(
      fromOrdered.nodes.map((n) => n.path),
      ordered.slice(0, GRAPH_NODE_CAP).map((r) => r.path)
    )
  })

  test('no returned edge references a node dropped by the cap', () => {
    const rows = makeManyRows(GRAPH_NODE_CAP + 20)
    // -> Every row links to the very last (guaranteed-dropped) row, and to the very first
    //    (guaranteed-retained) row -- if capped-out targets leaked through, half these edges would
    //    dangle.
    const droppedPath = rows.at(-1)!.path
    const retainedPath = rows[0]!.path
    for (const row of rows) {
      row.links = [droppedPath, retainedPath]
    }

    const result = assembleGraph(rows, () => true)
    const nodePaths = new Set(result.nodes.map((n) => n.path))

    assert.ok(result.truncated)
    for (const edge of result.edges) {
      assert.ok(nodePaths.has(edge.source), `edge source ${edge.source} is not a returned node`)
      assert.ok(nodePaths.has(edge.target), `edge target ${edge.target} is not a returned node`)
    }
    // -> Sanity: edges to the retained target did survive, so the assertion above isn't vacuously
    //    true from every edge having been dropped.
    assert.ok(result.edges.some((e) => e.target === retainedPath))
  })
})
