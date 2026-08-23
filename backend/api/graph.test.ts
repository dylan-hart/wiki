import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { assembleGraph, folderOf, type GraphPageRow } from './graph.ts'

function makeRow(overrides: Partial<GraphPageRow> = {}): GraphPageRow {
  return {
    path: 'docs/intro',
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
})
