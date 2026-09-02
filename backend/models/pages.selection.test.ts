import { describe, test, mock, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { pages as pagesTable } from '../db/schema.ts'

/**
 * OpenProject #1834: `getPage`'s `.select()` used to be `{ page: pagesTable, ... }`, which Drizzle
 * expands to every column of `pages` -- `content`, `searchContent`, the `ts` tsvector, `links`,
 * `historyData` and the generated `isSearchableComputed` included, none of which `toPage` reads
 * unconditionally. A real Postgres connection would only prove the query still returns the right
 * data, not that the column list sent to it actually shrank -- so this spies on `WIKI.db.select`
 * instead of standing up `setupTestDb()`, asserting directly on the selection object `getPage`
 * builds rather than re-describing it.
 */
describe('getPage selection (pure unit, OpenProject #1834)', () => {
  let previousWiki: typeof globalThis.WIKI

  /** A `WIKI.db.select`-shaped spy: records the selection config, then returns a chain ending in
   *  `.limit()`, which resolves to `[row]` (or `[]` when `row` is omitted). */
  function stubSelect(row?: Record<string, unknown>) {
    const calls: Record<string, unknown>[] = []
    const chain: any = {}
    chain.from = mock.fn(() => chain)
    chain.leftJoin = mock.fn(() => chain)
    chain.where = mock.fn(() => chain)
    chain.limit = mock.fn(async () => (row ? [row] : []))
    const select = mock.fn((config: Record<string, unknown>) => {
      calls.push(config)
      return chain
    })
    return { select, calls }
  }

  /** A row shaped like what the real query returns post-narrowing -- one key per selected column,
   *  `content` following the same CASE-in-SQL rule `getPage` builds (redirect editor only, unless
   *  `withContent`). */
  function fakeRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'page-1',
      path: 'docs/example',
      hash: 'hash-1',
      alias: null,
      title: 'Example',
      description: null,
      icon: null,
      locale: 'en',
      editor: 'markdown',
      contentType: 'markdown',
      publishState: 'published',
      publishStartDate: null,
      publishEndDate: null,
      isBrowsable: true,
      isSearchable: true,
      password: null,
      relations: [],
      tags: [],
      toc: [],
      render: '<p>hi</p>',
      content: null,
      config: {},
      scripts: {},
      authorId: 'user-1',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      classification: 'classification-1',
      authorName: 'Author',
      navigationId: null,
      navigationMode: 'inherit',
      ...overrides
    }
  }

  beforeEach(() => {
    previousWiki = globalThis.WIKI
  })

  afterEach(() => {
    globalThis.WIKI = previousWiki
  })

  test('the emitted selection omits searchContent/ts/historyData/links', async () => {
    const { select, calls } = stubSelect(fakeRow())
    globalThis.WIKI = { db: { select } } as unknown as typeof globalThis.WIKI
    const { pages: pagesModel } = await import('./pages.ts')

    await pagesModel.getPage({ siteId: 'site-1', id: 'page-1' })

    assert.equal(calls.length, 1)
    const selectedKeys = Object.keys(calls[0]!)
    for (const excluded of ['searchContent', 'ts', 'historyData', 'links']) {
      assert.ok(!selectedKeys.includes(excluded), `selection should omit ${excluded}`)
    }
    // -> Still selects everything toPage actually reads, plus password for the locked check.
    for (const included of ['render', 'toc', 'relations', 'tags', 'password', 'classification']) {
      assert.ok(selectedKeys.includes(included), `selection should include ${included}`)
    }
    // -> Without withContent, `content` is a CASE expression (redirect editor only), not the raw
    //    column -- an ordinary page view never asks the database for the full body.
    assert.notEqual(calls[0]!.content, pagesTable.content)
  })

  test('without withContent, a non-redirect page comes back with no content key', async () => {
    const { select } = stubSelect(fakeRow({ editor: 'markdown', content: null }))
    globalThis.WIKI = { db: { select } } as unknown as typeof globalThis.WIKI
    const { pages: pagesModel } = await import('./pages.ts')

    const page = await pagesModel.getPage({ siteId: 'site-1', id: 'page-1' })

    assert.ok(page)
    assert.equal(Object.hasOwn(page!, 'content'), false)
  })

  test('with withContent, content comes back and the selection asks the column for it directly', async () => {
    const { select, calls } = stubSelect(fakeRow({ content: '# Hello' }))
    globalThis.WIKI = { db: { select } } as unknown as typeof globalThis.WIKI
    const { pages: pagesModel } = await import('./pages.ts')

    const page = await pagesModel.getPage({ siteId: 'site-1', id: 'page-1', withContent: true })

    assert.equal(page?.content, '# Hello')
    // -> With withContent on, the column is selected directly rather than through the redirect CASE.
    assert.equal((calls[0] as any).content, pagesTable.content)
  })

  test('a redirect-editor page still comes back with content when withContent is off', async () => {
    const { select } = stubSelect(fakeRow({ editor: 'redirect', content: '/elsewhere' }))
    globalThis.WIKI = { db: { select } } as unknown as typeof globalThis.WIKI
    const { pages: pagesModel } = await import('./pages.ts')

    const page = await pagesModel.getPage({ siteId: 'site-1', id: 'page-1' })

    assert.equal(page?.content, '/elsewhere')
  })
})
