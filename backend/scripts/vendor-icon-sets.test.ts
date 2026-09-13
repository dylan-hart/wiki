import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildVendoredTablerCollection } from './vendor-icon-sets.ts'
import { parseSideloadIconCollection } from '../models/icons.ts'

/**
 * `buildVendoredTablerCollection()` (OpenProject #3043): reads the pinned `@iconify-json/tabler`
 * devDependency straight out of `node_modules` and merges its `icons.json` + `info.json` into one
 * full Iconify collection object. Exercises the real installed package rather than a fixture, since
 * the whole point of this script is to track that dependency -- a fixture would not catch the
 * package changing its own on-disk shape.
 */
describe('buildVendoredTablerCollection()', () => {
  it('merges icons.json and info.json into one collection matching parseSideloadIconCollection', () => {
    const collection = buildVendoredTablerCollection()

    const parsed = parseSideloadIconCollection(collection)
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.error)

    assert.equal(collection.prefix, 'tabler')
    assert.equal(typeof collection.width, 'number')
    assert.equal(typeof collection.height, 'number')
    assert.ok(Object.keys(collection.icons).length > 5000)
    assert.ok(Object.keys(collection.aliases ?? {}).length > 0)
    assert.equal((collection.info as any)?.license?.spdx, 'MIT')
  })
})
