import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isSpaAppRoute } from '../core/http/siteRouting.ts'
import {
  RESERVED_TWO_SEGMENT_PREFIXES,
  RESERVED_TWO_SEGMENT_URL_ROUTES,
  reservedTwoSegmentPrefix
} from './reservedPagePaths.ts'

describe('reservedTwoSegmentPrefix', () => {
  test('names the prefix of an exact two-segment a/<x> or i/<x> path', () => {
    assert.equal(reservedTwoSegmentPrefix('a/some-alias'), 'a')
    assert.equal(reservedTwoSegmentPrefix('i/2222'), 'i')
  })

  test('leaves a bare prefix, a deeper path and a nested prefix alone', () => {
    for (const pagePath of [
      'a',
      'i',
      'a/x/y',
      'i/x/y',
      'docs/a/x',
      'docs/i/x',
      'ab/x',
      'x/a',
      ''
    ]) {
      assert.equal(reservedTwoSegmentPrefix(pagePath), null, pagePath)
    }
  })

  test('agrees with the URL routes the SPA answers, for every prefix and shape', () => {
    assert.equal(RESERVED_TWO_SEGMENT_URL_ROUTES.length, RESERVED_TWO_SEGMENT_PREFIXES.length)
    const candidates = ['a', 'i', 'b', 'a/x', 'i/x', 'b/x', 'a/x/y', 'i/x/y', 'docs/a/x', 'a-b/x']
    for (const pagePath of candidates) {
      assert.equal(
        reservedTwoSegmentPrefix(pagePath) !== null,
        isSpaAppRoute(`/${pagePath}`),
        pagePath
      )
    }
  })
})
