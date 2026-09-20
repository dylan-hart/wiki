import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  belongsInTarget,
  categoryOf,
  normalizePathPrefix,
  objectKeyFor,
  parseLargeThreshold,
  type BlobTargetContentTypesConfig
} from './blobTarget.ts'

describe('objectKeyFor', () => {
  test('joins siteId, folder segments and file name with slashes', () => {
    assert.equal(
      objectKeyFor({ siteId: 'site-1', folderPath: 'photos/2026', fileName: 'cat.png' }),
      'site-1/photos/2026/cat.png'
    )
  })

  test('drops the folder segment entirely at the site root', () => {
    assert.equal(
      objectKeyFor({ siteId: 'site-1', folderPath: '', fileName: 'cat.png' }),
      'site-1/cat.png'
    )
  })

  test('is unaffected by a stray leading or trailing slash on folderPath', () => {
    assert.equal(
      objectKeyFor({ siteId: 'site-1', folderPath: '/photos/2026/', fileName: 'cat.png' }),
      'site-1/photos/2026/cat.png'
    )
  })

  test('produces the same key for two different sites sharing a folder and file name', () => {
    const a = objectKeyFor({ siteId: 'site-a', folderPath: 'docs', fileName: 'readme.pdf' })
    const b = objectKeyFor({ siteId: 'site-b', folderPath: 'docs', fileName: 'readme.pdf' })
    assert.notEqual(a, b)
    assert.equal(a, 'site-a/docs/readme.pdf')
    assert.equal(b, 'site-b/docs/readme.pdf')
  })
})

describe('objectKeyFor / pathPrefix', () => {
  const location = { siteId: 'site-1', folderPath: 'photos', fileName: 'cat.png' }

  test('no prefix, an empty prefix or a blank one is byte-identical to the unprefixed key', () => {
    const unprefixed = objectKeyFor(location)
    assert.equal(objectKeyFor({ ...location, pathPrefix: undefined }), unprefixed)
    assert.equal(objectKeyFor({ ...location, pathPrefix: '' }), unprefixed)
    assert.equal(objectKeyFor({ ...location, pathPrefix: '  /  ' }), unprefixed)
    assert.equal(unprefixed, 'site-1/photos/cat.png')
  })

  test('a prefix sits ahead of the siteId', () => {
    assert.equal(objectKeyFor({ ...location, pathPrefix: 'a/b' }), 'a/b/site-1/photos/cat.png')
  })

  test('leading, trailing and doubled slashes and whitespace are normalized away', () => {
    assert.equal(objectKeyFor({ ...location, pathPrefix: ' /a//b/ ' }), 'a/b/site-1/photos/cat.png')
  })

  test('dot and dot-dot segments are dropped, never traversed', () => {
    assert.equal(
      objectKeyFor({ ...location, pathPrefix: '../a/./b/../..' }),
      'a/b/site-1/photos/cat.png'
    )
    assert.equal(objectKeyFor({ ...location, pathPrefix: '..' }), 'site-1/photos/cat.png')
  })
})

describe('normalizePathPrefix', () => {
  test('a non-string value means no prefix', () => {
    assert.equal(normalizePathPrefix(undefined), '')
    assert.equal(normalizePathPrefix(null), '')
    assert.equal(normalizePathPrefix(42), '')
    assert.equal(normalizePathPrefix(['a']), '')
  })

  test('returns a slash-joined string with no leading or trailing slash', () => {
    assert.equal(normalizePathPrefix('/wiki//assets/'), 'wiki/assets')
  })
})

describe('parseLargeThreshold', () => {
  test('parses a whole-number-plus-unit string into bytes', () => {
    assert.equal(parseLargeThreshold('5MB', 0), 5 * 1024 * 1024)
    assert.equal(parseLargeThreshold('512KB', 0), 512 * 1024)
    assert.equal(parseLargeThreshold('1GB', 0), 1024 * 1024 * 1024)
    assert.equal(parseLargeThreshold('100B', 0), 100)
  })

  test('is case-insensitive', () => {
    assert.equal(parseLargeThreshold('5mb', 0), 5 * 1024 * 1024)
    assert.equal(parseLargeThreshold('5Mb', 0), 5 * 1024 * 1024)
  })

  test('tolerates a space between the number and unit', () => {
    assert.equal(parseLargeThreshold('5 MB', 0), 5 * 1024 * 1024)
  })

  test('parses a decimal amount', () => {
    assert.equal(parseLargeThreshold('2.5MB', 0), 2.5 * 1024 * 1024)
    assert.equal(parseLargeThreshold('0.5KB', 0), 0.5 * 1024)
  })

  test('falls back on an unparseable value', () => {
    assert.equal(parseLargeThreshold('not-a-size', 42), 42)
    assert.equal(parseLargeThreshold(undefined, 42), 42)
    assert.equal(parseLargeThreshold(null, 42), 42)
  })

  test('falls back on a zero-byte result', () => {
    assert.equal(parseLargeThreshold('0MB', 42), 42)
  })
})

describe('categoryOf', () => {
  test('maps an asset kind to its plural content-type category when under the threshold', () => {
    assert.equal(categoryOf({ kind: 'image', fileSize: 100 }, 1000), 'images')
    assert.equal(categoryOf({ kind: 'document', fileSize: 100 }, 1000), 'documents')
    assert.equal(categoryOf({ kind: 'other', fileSize: 100 }, 1000), 'others')
  })

  test('files an asset at or above the threshold as large, regardless of kind', () => {
    assert.equal(categoryOf({ kind: 'image', fileSize: 1000 }, 1000), 'large')
    assert.equal(categoryOf({ kind: 'document', fileSize: 5000 }, 1000), 'large')
  })
})

describe('belongsInTarget', () => {
  const config = (
    overrides: Partial<BlobTargetContentTypesConfig> = {}
  ): BlobTargetContentTypesConfig => ({
    activeTypes: ['images', 'documents', 'others', 'large'],
    largeThreshold: '5MB',
    ...overrides
  })

  test('accepts an asset whose category is active', () => {
    assert.equal(belongsInTarget({ kind: 'image', fileSize: 1024 }, config()), true)
  })

  test('rejects an asset whose category is not active', () => {
    assert.equal(
      belongsInTarget({ kind: 'image', fileSize: 1024 }, config({ activeTypes: ['documents'] })),
      false
    )
  })

  test('routes a large asset through the large bucket even if its kind is also active', () => {
    const oneOverFiveMb = 5 * 1024 * 1024 + 1
    assert.equal(
      belongsInTarget(
        { kind: 'image', fileSize: oneOverFiveMb },
        config({ activeTypes: ['images'] })
      ),
      false
    )
    assert.equal(
      belongsInTarget(
        { kind: 'image', fileSize: oneOverFiveMb },
        config({ activeTypes: ['large'] })
      ),
      true
    )
  })

  test('an unparseable largeThreshold never misclassifies a small asset as large', () => {
    assert.equal(
      belongsInTarget(
        { kind: 'image', fileSize: 100 },
        config({ largeThreshold: 'garbage', activeTypes: ['images'] })
      ),
      true
    )
  })
})
