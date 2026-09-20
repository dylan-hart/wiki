import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  SEARCH_FILTERS_MAX_ROWS,
  SEARCH_FILTER_VALUE_MAX_LENGTH,
  isSearchFilters,
  normalizeSearchFilters
} from './searchFilters.ts'

const row = { mode: 'exclude', type: 'path', value: 'departments/x' }

describe('isSearchFilters', () => {
  test('accepts an empty list and every type/mode pairing', () => {
    assert.equal(isSearchFilters([]), true)
    for (const mode of ['include', 'exclude']) {
      for (const type of ['path', 'tag', 'locale', 'editor']) {
        assert.equal(isSearchFilters([{ mode, type, value: 'x' }]), true)
      }
      assert.equal(isSearchFilters([{ mode, type: 'publishState', value: 'draft' }]), true)
    }
  })

  test('rejects a non-array', () => {
    assert.equal(isSearchFilters(undefined), false)
    assert.equal(isSearchFilters(null), false)
    assert.equal(isSearchFilters(row), false)
    assert.equal(isSearchFilters('path'), false)
  })

  test('rejects an unknown mode or type, including creator/author', () => {
    assert.equal(isSearchFilters([{ ...row, mode: 'require' }]), false)
    assert.equal(isSearchFilters([{ ...row, type: 'creator' }]), false)
    assert.equal(isSearchFilters([{ ...row, type: 'author' }]), false)
  })

  test('rejects a missing, empty, non-string or oversized value', () => {
    assert.equal(isSearchFilters([{ mode: 'include', type: 'tag' }]), false)
    assert.equal(isSearchFilters([{ ...row, value: '' }]), false)
    assert.equal(isSearchFilters([{ ...row, value: 5 }]), false)
    assert.equal(
      isSearchFilters([{ ...row, value: 'a'.repeat(SEARCH_FILTER_VALUE_MAX_LENGTH) }]),
      true
    )
    assert.equal(
      isSearchFilters([{ ...row, value: 'a'.repeat(SEARCH_FILTER_VALUE_MAX_LENGTH + 1) }]),
      false
    )
  })

  test('rejects a publishState value that is not a page publish state', () => {
    assert.equal(isSearchFilters([{ mode: 'include', type: 'publishState', value: 'live' }]), false)
  })

  test('caps the row count', () => {
    assert.equal(isSearchFilters(Array(SEARCH_FILTERS_MAX_ROWS).fill(row)), true)
    assert.equal(isSearchFilters(Array(SEARCH_FILTERS_MAX_ROWS + 1).fill(row)), false)
  })

  test('rejects a non-object row', () => {
    assert.equal(isSearchFilters([null]), false)
    assert.equal(isSearchFilters([['include', 'path', 'x']]), false)
    assert.equal(isSearchFilters(['path']), false)
  })
})

describe('normalizeSearchFilters', () => {
  test('keeps only mode, type and value', () => {
    const rows = [{ ...row, extra: true }] as any
    assert.deepEqual(normalizeSearchFilters(rows), [row])
  })
})
