/**
 * Pure unit tests for `getFileExtension` — no DB needed, this is a plain string mapping.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { getFileExtension } from './storage.ts'

describe('storage: getFileExtension', () => {
  test('maps markdown to md', () => {
    assert.equal(getFileExtension('markdown'), 'md')
  })

  test('maps asciidoc to adoc', () => {
    assert.equal(getFileExtension('asciidoc'), 'adoc')
  })

  test('maps html to html', () => {
    assert.equal(getFileExtension('html'), 'html')
  })

  test('falls back to txt for a content type with no file representation', () => {
    assert.equal(getFileExtension('redirect'), 'txt')
    assert.equal(getFileExtension('something-unknown'), 'txt')
  })
})
