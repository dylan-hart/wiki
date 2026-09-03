import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { normalizeMigratedPath, normalizeSegment } from './path-normalization.ts'

describe('normalizeSegment', () => {
  test('lowercases a segment', () => {
    assert.equal(normalizeSegment('FooBar'), 'foobar')
  })

  test('folds underscores to hyphens', () => {
    assert.equal(normalizeSegment('my_page_name'), 'my-page-name')
  })

  test('leaves an already-legal segment untouched but for casing', () => {
    assert.equal(normalizeSegment('already-legal-123'), 'already-legal-123')
  })

  test('rejects a segment that is still illegal after folding', () => {
    // Not reachable through 2.x's own rePagePath in practice, but this module must not crash on it.
    assert.equal(normalizeSegment('has a space'), null)
  })
})

describe('normalizeMigratedPath', () => {
  test('splits a multi-segment path into parentPath + fileName', () => {
    const result = normalizeMigratedPath('Guide/Getting_Started')
    assert.deepEqual(result, {
      parentPath: 'guide',
      fileName: 'getting-started',
      path: 'guide/getting-started'
    })
  })

  test('a single-segment path has an empty parentPath (site root)', () => {
    const result = normalizeMigratedPath('Welcome')
    assert.deepEqual(result, { parentPath: '', fileName: 'welcome', path: 'welcome' })
  })

  test('strips leading and trailing slashes', () => {
    const result = normalizeMigratedPath('/guide/intro/')
    assert.deepEqual(result, { parentPath: 'guide', fileName: 'intro', path: 'guide/intro' })
  })

  test('reports empty-path for a path that is blank once trimmed', () => {
    const result = normalizeMigratedPath('   ')
    assert.equal('reason' in result && result.reason, 'empty-path')
  })

  test('reports invalid-segment for consecutive slashes (empty segment)', () => {
    const result = normalizeMigratedPath('guide//intro')
    assert.equal('reason' in result && result.reason, 'invalid-segment')
  })

  test('reports invalid-segment for a character no amount of folding fixes', () => {
    const result = normalizeMigratedPath('guide/a b')
    assert.equal('reason' in result && result.reason, 'invalid-segment')
  })
})
