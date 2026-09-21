import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { compareFoldersFirst, TREE_ORDER_BY } from './tree.ts'

describe('compareFoldersFirst', () => {
  const entry = (title: string, sortOrder?: number | null, isFolder = false) => ({
    isFolder,
    title,
    sortOrder
  })

  test('sorts by title when no entry carries a sortOrder', () => {
    const sorted = [entry('b'), entry('a'), entry('c', null)].toSorted(compareFoldersFirst)
    assert.deepEqual(
      sorted.map((item) => item.title),
      ['a', 'b', 'c']
    )
  })

  test('sorts positioned entries by sortOrder, ahead of unpositioned ones', () => {
    const sorted = [entry('a'), entry('c', 2), entry('b', 1), entry('d', null)].toSorted(
      compareFoldersFirst
    )
    assert.deepEqual(
      sorted.map((item) => item.title),
      ['b', 'c', 'a', 'd']
    )
  })

  test('keeps folders ahead of pages whatever their sortOrder', () => {
    const sorted = [entry('page', 0), entry('folder', 9, true)].toSorted(compareFoldersFirst)
    assert.deepEqual(
      sorted.map((item) => item.title),
      ['folder', 'page']
    )
  })

  test('breaks a sortOrder tie by title', () => {
    const sorted = [entry('b', 1), entry('a', 1)].toSorted(compareFoldersFirst)
    assert.deepEqual(
      sorted.map((item) => item.title),
      ['a', 'b']
    )
  })
})

test('sortOrder is an accepted tree ordering', () => {
  assert.ok((TREE_ORDER_BY as readonly string[]).includes('sortOrder'))
})
