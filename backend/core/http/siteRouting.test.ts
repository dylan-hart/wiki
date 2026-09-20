import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { isPageUrl, RESERVED_ROOT_FILES, SERVER_ROUTE_SEGMENTS } from './siteRouting.ts'

describe('isPageUrl', () => {
  test('a plain page path addresses the page tree', () => {
    assert.equal(isPageUrl('/home'), true)
    assert.equal(isPageUrl('/docs/getting-started'), true)
    assert.equal(isPageUrl('/'), true)
  })

  test('every server-owned first segment is excluded', () => {
    for (const segment of SERVER_ROUTE_SEGMENTS) {
      assert.equal(isPageUrl(`/${segment}/anything`), false, `${segment} should not be a page path`)
    }
  })

  test('every reserved root file is excluded, case-insensitively', () => {
    for (const file of RESERVED_ROOT_FILES) {
      assert.equal(isPageUrl(`/${file}`), false, `${file} should not be a page path`)
      assert.equal(isPageUrl(`/${file.toUpperCase()}`), false)
    }
  })

  test("the frontend router's own underscore routes are still not page paths", () => {
    // -> They reach the app shell through `registerAppShellFallback`. The prefix test cannot tell
    //    them apart from `/_api`, which is why `SERVER_ROUTE_SEGMENTS` is spelled out.
    assert.equal(isPageUrl('/_admin/general'), false)
    assert.equal(SERVER_ROUTE_SEGMENTS.has('_admin'), false)
  })
})

describe('SERVER_ROUTE_SEGMENTS', () => {
  test('covers `/_api`, the one prefix every route file under api/ is mounted behind', () => {
    // -> A cheap floor rather than a full cross-check against `core/http/routes.ts`: with `/_api`
    //    dropped, an unmatched API path would answer with the app shell instead of a 404.
    assert.equal(SERVER_ROUTE_SEGMENTS.has('_api'), true)
  })

  test('every entry is an underscore-prefixed single segment', () => {
    for (const segment of SERVER_ROUTE_SEGMENTS) {
      assert.match(segment, /^_[a-z]+$/, `${segment} should be one underscore-prefixed segment`)
    }
  })
})

describe('RESERVED_ROOT_FILES', () => {
  test('holds exactly the unprefixed root paths the server answers itself', () => {
    assert.deepEqual([...RESERVED_ROOT_FILES].sort(), [
      'favicon.ico',
      'metrics',
      'robots.txt',
      'sitemap.xml'
    ])
  })

  test('is stored lowercase, since isPageUrl lowercases before looking up', () => {
    for (const file of RESERVED_ROOT_FILES) {
      assert.equal(file, file.toLowerCase())
    }
  })
})
