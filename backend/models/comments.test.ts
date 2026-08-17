import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { comments as commentsTable } from '../db/schema.ts'
import type { PageActor } from './pages.ts'

/**
 * Task 625 (Feature 394): the data-access layer behind the admin comment moderation listing. Covers
 * `pageRefsForSite` (the narrow page-ref query `api/comments.ts`'s permission-scoping strategy is
 * built on) and `listForAdmin` (pagination, and each of the three filters) directly against a real
 * database — no mock of the query builder, since almost everything here IS the query.
 *
 * Permission scoping itself (which page ids reach `listForAdmin` at all) is `api/comments.ts`'s job,
 * not this model's — see the DB-backed route test in `api/comments.admin.test.ts` for that half.
 */
describe('comments (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let commentsModel: typeof import('./comments.ts').comments
  let pagesModel: typeof import('./pages.ts').pages
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    ;({ comments: commentsModel } = await import('./comments.ts'))
    ;({ pages: pagesModel } = await import('./pages.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'] }
  })

  after(async () => {
    await teardownTestDb()
  })

  /** Inserts a comment directly (this model has no `create` of its own — that's Feature 391's). */
  async function insertComment(overrides: Partial<typeof commentsTable.$inferInsert> = {}) {
    const rows = await fixtures.db
      .insert(commentsTable)
      .values({
        siteId: fixtures.siteId,
        content: 'A comment',
        ...overrides
      } as typeof commentsTable.$inferInsert)
      .returning()
    return rows[0]!
  }

  test('pageRefsForSite returns every page on the site, narrowed by a path prefix filter', async () => {
    const docsA = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'refs-docs/a', title: 'A', editor: 'markdown', content: 'x' },
      actor
    )
    const docsB = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'refs-docs/b', title: 'B', editor: 'markdown', content: 'x' },
      actor
    )
    const otherC = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'refs-other/c', title: 'C', editor: 'markdown', content: 'x' },
      actor
    )

    const all = await commentsModel.pageRefsForSite(fixtures.siteId)
    const allIds = all.map((p) => p.id)
    assert.ok(allIds.includes(docsA.id))
    assert.ok(allIds.includes(docsB.id))
    assert.ok(allIds.includes(otherC.id))

    const docsOnly = await commentsModel.pageRefsForSite(fixtures.siteId, 'refs-docs')
    const docsOnlyIds = docsOnly.map((p) => p.id)
    assert.ok(docsOnlyIds.includes(docsA.id))
    assert.ok(docsOnlyIds.includes(docsB.id))
    assert.ok(!docsOnlyIds.includes(otherC.id))
  })

  test('listForAdmin returns an empty page without querying comments when pageIds is empty', async () => {
    const result = await commentsModel.listForAdmin({ siteId: fixtures.siteId, pageIds: [] })
    assert.deepEqual(result, { results: [], totalHits: 0 })
  })

  test('listForAdmin restricts to the given pageIds, paginates newest-first, and totalHits ignores limit/offset', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'paginate/target', title: 'Target', editor: 'markdown', content: 'x' },
      actor
    )
    const otherPage = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'paginate/other', title: 'Other', editor: 'markdown', content: 'x' },
      actor
    )
    // -> On the other page: must never appear in a query scoped to `[page.id]` alone.
    const otherPageComment = await insertComment({
      pageId: otherPage.id,
      content: 'Not accessible',
      createdAt: new Date('2026-01-01T00:00:00Z')
    })

    const base = new Date('2026-02-01T00:00:00Z').getTime()
    const inserted = []
    for (let i = 0; i < 5; i++) {
      inserted.push(
        await insertComment({
          pageId: page.id,
          content: `Comment ${i}`,
          createdAt: new Date(base + i * 60_000)
        })
      )
    }

    const firstPage = await commentsModel.listForAdmin({
      siteId: fixtures.siteId,
      pageIds: [page.id],
      limit: 2,
      offset: 0
    })
    assert.equal(firstPage.totalHits, 5)
    assert.equal(firstPage.results.length, 2)
    // -> Newest first: index 4 ("Comment 4") has the latest createdAt.
    assert.equal(firstPage.results[0]!.content, 'Comment 4')
    assert.equal(firstPage.results[1]!.content, 'Comment 3')
    assert.equal(firstPage.results[0]!.pagePath, 'paginate/target')

    const secondPage = await commentsModel.listForAdmin({
      siteId: fixtures.siteId,
      pageIds: [page.id],
      limit: 2,
      offset: 2
    })
    assert.equal(secondPage.totalHits, 5)
    assert.equal(secondPage.results.length, 2)
    assert.equal(secondPage.results[0]!.content, 'Comment 2')

    // -> `otherPage`'s comment must never surface from a query scoped to `[page.id]` alone.
    const idsFromEitherRequest = [...firstPage.results, ...secondPage.results].map((c) => c.id)
    assert.ok(!idsFromEitherRequest.includes(otherPageComment.id))
    // -> Every one of the 5 inserted comments is accounted for across both pages.
    assert.equal(new Set([...idsFromEitherRequest, ...inserted.map((c) => c.id)]).size, 5)
  })

  test('listForAdmin filters by author, matching either the account name or the guest name', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'authors/page', title: 'Authors', editor: 'markdown', content: 'x' },
      actor
    )
    await insertComment({ pageId: page.id, authorId: fixtures.userId, content: 'From the account' })
    await insertComment({
      pageId: page.id,
      authorId: null,
      guestName: 'Casual Visitor',
      guestEmail: 'visitor@example.com',
      content: 'From a guest'
    })

    const byAccount = await commentsModel.listForAdmin({
      siteId: fixtures.siteId,
      pageIds: [page.id],
      author: 'Fixture'
    })
    assert.equal(byAccount.totalHits, 1)
    assert.equal(byAccount.results[0]!.content, 'From the account')
    assert.equal(byAccount.results[0]!.authorName, 'Fixture User')

    const byGuest = await commentsModel.listForAdmin({
      siteId: fixtures.siteId,
      pageIds: [page.id],
      author: 'visitor'
    })
    assert.equal(byGuest.totalHits, 1)
    assert.equal(byGuest.results[0]!.content, 'From a guest')
    assert.equal(byGuest.results[0]!.authorName, 'Casual Visitor')
  })

  test('listForAdmin filters by a createdAt date range', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'dates/page', title: 'Dates', editor: 'markdown', content: 'x' },
      actor
    )
    await insertComment({
      pageId: page.id,
      content: 'Too early',
      createdAt: new Date('2025-01-01T00:00:00Z')
    })
    const inRange = await insertComment({
      pageId: page.id,
      content: 'In range',
      createdAt: new Date('2025-06-15T00:00:00Z')
    })
    await insertComment({
      pageId: page.id,
      content: 'Too late',
      createdAt: new Date('2026-01-01T00:00:00Z')
    })

    const result = await commentsModel.listForAdmin({
      siteId: fixtures.siteId,
      pageIds: [page.id],
      dateFrom: new Date('2025-03-01T00:00:00Z'),
      dateTo: new Date('2025-09-01T00:00:00Z')
    })
    assert.equal(result.totalHits, 1)
    assert.equal(result.results[0]!.id, inRange.id)
  })

  test('getWithPage returns the comment with its page ref, or null when it does not exist', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'get-with-page/target', title: 'Target', editor: 'markdown', content: 'x' },
      actor
    )
    const comment = await insertComment({ pageId: page.id, content: 'Look me up' })

    const found = await commentsModel.getWithPage(comment.id)
    assert.ok(found)
    assert.equal(found!.id, comment.id)
    assert.equal(found!.siteId, fixtures.siteId)
    assert.equal(found!.pageId, page.id)
    assert.equal(found!.page.path, 'get-with-page/target')

    const missing = await commentsModel.getWithPage('00000000-0000-0000-0000-000000000000')
    assert.equal(missing, null)
  })

  test('delete removes the comment', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'delete-me/target', title: 'Target', editor: 'markdown', content: 'x' },
      actor
    )
    const comment = await insertComment({ pageId: page.id, content: 'Delete me' })

    await commentsModel.delete(comment.id)

    const found = await commentsModel.getWithPage(comment.id)
    assert.equal(found, null)
  })
})
