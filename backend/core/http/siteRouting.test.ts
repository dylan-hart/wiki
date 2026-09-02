import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { isPageUrl, RESERVED_ROOT_FILES, SERVER_ROUTE_SEGMENTS } from './siteRouting.ts'
import { listApiRouteFiles } from '../../test/routeRecorder.ts'
import path from 'node:path'

/**
 * `RESERVED_ROOT_FILES`, `SERVER_ROUTE_SEGMENTS` and `isPageUrl` are exported but were reached by
 * nothing outside this file after A15 lifted them out of `index.ts` — an export with no consumer is
 * indistinguishable from a leftover. They are genuinely worth exporting: each one encodes a decision
 * (which unprefixed root paths the server keeps for itself, which underscore segments are the
 * SERVER's rather than the frontend router's) that a reader of `controllers/metrics.ts` or
 * `controllers/seo.ts` is pointed at by name. This suite is what makes them reached, and what would
 * catch either set drifting out of step with the routes it describes.
 */

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
    // -> They reach the app shell through `registerAppShellFallback`, not through `isPageUrl` — the
    //    prefix test cannot tell them apart from `/_api`, which is exactly why
    //    `SERVER_ROUTE_SEGMENTS` is spelled out rather than derived from it.
    assert.equal(isPageUrl('/_admin/general'), false)
    assert.equal(SERVER_ROUTE_SEGMENTS.has('_admin'), false)
  })
})

describe('SERVER_ROUTE_SEGMENTS', () => {
  test('covers `/_api`, the one prefix every route file under api/ is mounted behind', () => {
    // -> A cheap floor rather than a full cross-check against `core/http/routes.ts`: what would
    //    actually break is `/_api` dropping out, which would send every API call to the app shell.
    assert.equal(SERVER_ROUTE_SEGMENTS.has('_api'), true)
    assert.ok(listApiRouteFiles(path.join(import.meta.dirname, '../../api')).length > 0)
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
