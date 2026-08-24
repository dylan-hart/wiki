import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { assembleGraph, folderOf, type GraphPageRow } from './graph.ts'

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
