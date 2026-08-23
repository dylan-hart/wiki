import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { assembleGraph, folderOf, type GraphPageRow } from './graph.ts'

// -> The system "Public" classification level's fixed id (OpenProject #1079, `base.yml`) -- same
//    constant `api/pages.classification.test.ts` uses. `GraphPageRow.classification` is non-null
//    (the db column is `NOT NULL DEFAULT` this id), so every fixture row needs a value even though
//    assembleGraph itself doesn't read it.
const PUBLIC_ID = '30000000-0000-4000-8000-000000000001'

function makeRow(overrides: Partial<GraphPageRow> = {}): GraphPageRow {
  return {
    path: 'docs/intro',
    locale: 'en',
    title: 'Intro',
    icon: null,
    tags: [],
    classification: PUBLIC_ID,
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
})
