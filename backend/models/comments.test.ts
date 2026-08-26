import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it, test } from 'node:test'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { comments as commentsTable } from '../db/schema.ts'
import type { PageActor } from './pages.ts'

// Node 26 (this repo's target runtime, per CLAUDE.md) provides `Temporal` as a native global. This
// dev environment runs an older Node without it, so shim just enough of `Temporal.Now.instant()` for
// `comments.update()` — which genuinely calls the real global, unmodified — to run here too.
if (typeof (globalThis as any).Temporal === 'undefined') {
  ;(globalThis as any).Temporal = {
    Now: { instant: () => ({ epochMilliseconds: Date.now() }) }
  }
}

/**
 * Two independently-built test suites over `models/comments.ts`, merged into one file at
 * merge-review time (see the model file's own header for the merge story). Kept as two separate,
 * self-scoped `describe` blocks rather than interleaved: the first mocks `WIKI.db` to unit-test
 * `create`/`update`/`delete`/`listForPage`/`countForPage` with no real database; the second runs
 * `pageRefsForSite`/`listForAdmin`/`getWithPage`/`delete` against a real throwaway Postgres. Each
 * block's `before`/`beforeEach`/`after` are scoped to its own `describe` so the mock-db setup in the
 * first block cannot clobber the real db connection the second block depends on.
 */
describe('comments model — mocked', () => {
  /**
   * Fake `WIKI.db` — just enough of the drizzle chain shape for `create`/`update`/`delete` to run
   * against, with no real postgres involved. Each call is recorded so the assertions below can check
   * what the model handed to the query builder.
   */
  interface RecordedInsert {
    values: Record<string, unknown>
  }
  interface RecordedUpdate {
    set: Record<string, unknown>
    where: unknown
  }
  interface RecordedDelete {
    where: unknown
  }
  interface RecordedSelect {
    where: unknown
  }
  interface RecordedCount {
    where: unknown
  }

  const calls: {
    inserts: RecordedInsert[]
    updates: RecordedUpdate[]
    deletes: RecordedDelete[]
    selects: RecordedSelect[]
    counts: RecordedCount[]
  } = { inserts: [], updates: [], deletes: [], selects: [], counts: [] }

  /**
   * `selectRows`/`countValue` let each `listForPage`/`countForPage` test control what the fake
   * `SELECT ... LEFT JOIN` / `$count` chain hands back, without needing a real postgres underneath —
   * this model's threading and fallback-name logic runs entirely in application code over whatever rows
   * the query returns, so the query itself doesn't need to be real to exercise that logic.
   *
   * `getRows` backs the plain `select().from().where().limit()` chain `get()` runs — which `delete()`
   * now calls internally (OpenProject #1923) to fetch the row a `comment:delete` hook payload needs
   * before removing it. Empty by default, matching `get()` returning `null` for an id the fake db was
   * never told about — the pre-#1923 `delete` tests rely on exactly that to keep passing unchanged.
   *
   * `updateRow` fills in the full-row fields (`siteId`/`pageId`/`authorId`/`guestName`/`replyTo`) a
   * real `UPDATE ... RETURNING` would still carry that `update()`'s own `set` never touches — needed
   * so a test can assert on `comment:edit`'s emitted payload without reconstructing the whole row by
   * hand every time.
   */
  function makeFakeDb(
    config: {
      selectRows?: unknown[]
      countValue?: number
      getRows?: unknown[]
      updateRow?: Record<string, unknown>
    } = {}
  ) {
    return {
      insert: () => ({
        values: (values: Record<string, unknown>) => ({
          returning: async () => {
            calls.inserts.push({ values })
            return [
              {
                id: 'new-comment-id',
                createdAt: new Date('2026-08-16T00:00:00.000Z'),
                updatedAt: new Date('2026-08-16T00:00:00.000Z'),
                render: null,
                ...values
              }
            ]
          }
        })
      }),
      update: () => ({
        set: (set: Record<string, unknown>) => ({
          where: (where: unknown) => ({
            returning: async () => {
              calls.updates.push({ set, where })
              return [{ id: 'existing-comment-id', ...config.updateRow, ...set }]
            }
          })
        })
      }),
      delete: () => ({
        where: async (where: unknown) => {
          calls.deletes.push({ where })
        }
      }),
      select: (_columns: Record<string, unknown>) => ({
        from: (_table: unknown) => ({
          leftJoin: (_joinTable: unknown, _on: unknown) => ({
            where: (where: unknown) => ({
              orderBy: async (_orderBy: unknown) => {
                calls.selects.push({ where })
                return config.selectRows ?? []
              }
            })
          }),
          where: (where: unknown) => ({
            limit: async (_n: number) => {
              calls.selects.push({ where })
              return config.getRows ?? []
            }
          })
        })
      }),
      $count: async (_table: unknown, where: unknown) => {
        calls.counts.push({ where })
        return config.countValue ?? 0
      }
    }
  }

  let comments: typeof import('./comments.ts').comments

  /**
   * `create`/`update`/`delete` each queue a hook themselves now (OpenProject #1923, moved out of
   * `api/comments.ts`) — `hookEmits` records every `WIKI.models.hooks.emit()` call so a test can
   * assert on the payload directly, and `usersById` is `WIKI.models.users.getById`'s backing store for
   * the `authorName` resolution that payload needs.
   */
  let hookEmits: { event: string; siteId: string | null; data: Record<string, any> }[]
  let usersById: Record<string, { name: string }>

  before(async () => {
    hookEmits = []
    usersById = {}
    ;(globalThis as any).WIKI = {
      db: makeFakeDb(),
      models: {
        hooks: {
          emit: async (event: string, siteId: string | null, data: Record<string, any> = {}) => {
            hookEmits.push({ event, siteId, data })
            return 1
          }
        },
        users: {
          getById: async (id: string) => usersById[id] ?? null
        }
      }
    }
    ;({ comments } = await import('./comments.ts'))
  })

  beforeEach(() => {
    calls.inserts.length = 0
    calls.updates.length = 0
    calls.deletes.length = 0
    calls.selects.length = 0
    calls.counts.length = 0
    hookEmits.length = 0
    usersById = {}
    ;(globalThis as any).WIKI.db = makeFakeDb()
  })

  /** A minimal row shaped exactly like `listForPage`'s `SELECT ... LEFT JOIN users` projection. */
  function row(overrides: Record<string, unknown>) {
    return {
      id: 'c1',
      siteId: 's1',
      pageId: 'p1',
      authorId: null,
      authorName: null,
      guestName: null,
      replyTo: null,
      content: 'a comment',
      render: null,
      createdAt: new Date('2026-08-16T00:00:00.000Z'),
      updatedAt: new Date('2026-08-16T00:00:00.000Z'),
      ...overrides
    }
  }

  describe('create', () => {
    it('rejects content trimmed below 2 characters', async () => {
      await assert.rejects(
        () => comments.create({ siteId: 's1', pageId: 'p1', content: ' a ' }),
        /at least 2 characters/
      )
      assert.equal(calls.inserts.length, 0, 'must not touch the db when validation fails')
    })

    it('rejects whitespace-only content', async () => {
      await assert.rejects(() => comments.create({ siteId: 's1', pageId: 'p1', content: '   ' }))
    })

    it('trims content before storing it', async () => {
      await comments.create({ siteId: 's1', pageId: 'p1', content: '  hello there  ' })
      assert.equal(calls.inserts[0].values.content, 'hello there')
    })

    it('defaults optional fields to null and returns the stored row', async () => {
      const row = await comments.create({ siteId: 's1', pageId: 'p1', content: 'hi there' })
      assert.equal(calls.inserts[0].values.authorId, null)
      assert.equal(calls.inserts[0].values.replyTo, null)
      assert.equal(calls.inserts[0].values.guestName, null)
      assert.equal(calls.inserts[0].values.guestEmail, null)
      assert.equal(calls.inserts[0].values.guestIp, null)
      assert.equal(row.id, 'new-comment-id')
    })

    it('passes through authorId, replyTo and guest fields when given', async () => {
      await comments.create({
        siteId: 's1',
        pageId: 'p1',
        authorId: 'u1',
        replyTo: 'c1',
        content: 'a reply',
        guestName: 'Guest',
        guestEmail: 'guest@example.com',
        guestIp: '127.0.0.1'
      })
      const values = calls.inserts[0].values
      assert.equal(values.authorId, 'u1')
      assert.equal(values.replyTo, 'c1')
      assert.equal(values.guestName, 'Guest')
      assert.equal(values.guestEmail, 'guest@example.com')
      assert.equal(values.guestIp, '127.0.0.1')
    })

    it('emits comment:new with the stored row and the resolved author name (OpenProject #1923)', async () => {
      usersById['u1'] = { name: 'Alice' }
      const comment = await comments.create({
        siteId: 's1',
        pageId: 'p1',
        authorId: 'u1',
        replyTo: 'parent-1',
        content: 'a reply'
      })

      assert.equal(hookEmits.length, 1, 'create must emit exactly one hook')
      assert.equal(hookEmits[0].event, 'comment:new')
      assert.equal(hookEmits[0].siteId, 's1')
      assert.equal(hookEmits[0].data.id, comment.id)
      assert.equal(hookEmits[0].data.pageId, 'p1')
      assert.equal(hookEmits[0].data.siteId, 's1')
      assert.equal(hookEmits[0].data.authorId, 'u1')
      assert.equal(hookEmits[0].data.isGuest, false)
      assert.equal(hookEmits[0].data.content, 'a reply')
      assert.deepEqual(hookEmits[0].data.metadata, { authorName: 'Alice', replyTo: 'parent-1' })
    })

    it('emits comment:new with isGuest true, a null authorId and the guestName as authorName', async () => {
      await comments.create({
        siteId: 's1',
        pageId: 'p1',
        content: 'a guest comment',
        guestName: 'Casey',
        guestEmail: 'casey@example.com'
      })

      assert.equal(hookEmits.length, 1)
      assert.equal(hookEmits[0].event, 'comment:new')
      assert.equal(hookEmits[0].data.authorId, null)
      assert.equal(hookEmits[0].data.isGuest, true)
      assert.equal(hookEmits[0].data.metadata.authorName, 'Casey')
    })
  })

  describe('update', () => {
    it('rejects content trimmed below 2 characters and does not touch the db', async () => {
      await assert.rejects(() => comments.update('c1', { content: 'x' }), /at least 2 characters/)
      assert.equal(calls.updates.length, 0)
      assert.equal(hookEmits.length, 0, 'must not emit when validation fails before any write')
    })

    it('trims content and stamps updatedAt as a Date derived from Temporal.Now.instant()', async () => {
      const beforeMs = Date.now()
      const row = await comments.update('c1', { content: '  edited  ' })
      const afterMs = Date.now()

      assert.equal(calls.updates[0].set.content, 'edited')
      const updatedAt = calls.updates[0].set.updatedAt as Date
      assert.ok(updatedAt instanceof Date, 'updatedAt must be a Date for the timestamp column')
      assert.ok(updatedAt.getTime() >= beforeMs && updatedAt.getTime() <= afterMs)
      assert.equal(row.id, 'existing-comment-id')
    })

    it('emits comment:edit with the updated row and the resolved author name (OpenProject #1923)', async () => {
      usersById['u2'] = { name: 'Bob' }
      ;(globalThis as any).WIKI.db = makeFakeDb({
        updateRow: { siteId: 's1', pageId: 'p1', authorId: 'u2', guestName: null, replyTo: null }
      })

      const updated = await comments.update('c1', { content: 'edited content' })

      assert.equal(hookEmits.length, 1, 'update must emit exactly one hook')
      assert.equal(hookEmits[0].event, 'comment:edit')
      assert.equal(hookEmits[0].siteId, 's1')
      assert.equal(hookEmits[0].data.id, updated.id)
      assert.equal(hookEmits[0].data.pageId, 'p1')
      assert.equal(hookEmits[0].data.authorId, 'u2')
      assert.equal(hookEmits[0].data.isGuest, false)
      assert.equal(hookEmits[0].data.content, 'edited content')
      assert.equal(hookEmits[0].data.metadata.authorName, 'Bob')
    })
  })

  describe('delete', () => {
    it('issues a delete scoped by a where clause', async () => {
      await comments.delete('c1')
      assert.equal(calls.deletes.length, 1)
      assert.ok(calls.deletes[0].where, 'expected a where clause to scope the delete')
    })

    it('does not emit when the comment never existed', async () => {
      await comments.delete('does-not-exist')
      assert.equal(hookEmits.length, 0)
    })

    it(
      'fetches the row first and emits comment:delete with only the base identity fields, no ' +
        'content or metadata (OpenProject #1923)',
      async () => {
        ;(globalThis as any).WIKI.db = makeFakeDb({
          getRows: [
            {
              id: 'c1',
              siteId: 's1',
              pageId: 'p1',
              authorId: 'u1',
              replyTo: null,
              content: 'about to be deleted',
              guestName: null
            }
          ]
        })

        await comments.delete('c1')

        assert.equal(calls.deletes.length, 1, 'the delete itself must still run')
        assert.equal(hookEmits.length, 1)
        assert.equal(hookEmits[0].event, 'comment:delete')
        assert.equal(hookEmits[0].siteId, 's1')
        assert.deepEqual(hookEmits[0].data, {
          id: 'c1',
          pageId: 'p1',
          siteId: 's1',
          authorId: 'u1',
          isGuest: false
        })
      }
    )

    it('emits comment:delete with isGuest true and a null authorId for a guest comment', async () => {
      ;(globalThis as any).WIKI.db = makeFakeDb({
        getRows: [
          {
            id: 'c2',
            siteId: 's1',
            pageId: 'p1',
            authorId: null,
            replyTo: null,
            content: 'a guest comment',
            guestName: 'Casey'
          }
        ]
      })

      await comments.delete('c2')

      assert.equal(hookEmits[0].data.authorId, null)
      assert.equal(hookEmits[0].data.isGuest, true)
    })
  })

  describe('listForPage', () => {
    it('returns [] for a page with zero comments, rather than throwing', async () => {
      ;(globalThis as any).WIKI.db = makeFakeDb({ selectRows: [] })
      const result = await comments.listForPage('p1')
      assert.deepEqual(result, [])
      assert.equal(calls.selects.length, 1, 'expected a single flat query, not per-comment lookups')
    })

    it('nests a reply under its parent instead of returning it as a sibling top-level comment', async () => {
      ;(globalThis as any).WIKI.db = makeFakeDb({
        selectRows: [
          row({ id: 'c1', authorId: 'u1', authorName: 'Alice', replyTo: null, content: 'root' }),
          row({
            id: 'c2',
            authorId: 'u2',
            authorName: 'Bob',
            replyTo: 'c1',
            content: 'a reply',
            createdAt: new Date('2026-08-16T00:01:00.000Z')
          })
        ]
      })

      const result = await comments.listForPage('p1')

      assert.equal(result.length, 1, 'only the top-level comment should be at the root')
      assert.equal(result[0].id, 'c1')
      assert.equal(result[0].replies.length, 1)
      assert.equal(result[0].replies[0].id, 'c2')
      assert.equal(result[0].replies[0].replyTo, 'c1')
    })

    it('nests a reply-to-a-reply two levels deep', async () => {
      ;(globalThis as any).WIKI.db = makeFakeDb({
        selectRows: [
          row({ id: 'c1', replyTo: null }),
          row({ id: 'c2', replyTo: 'c1', createdAt: new Date('2026-08-16T00:01:00.000Z') }),
          row({ id: 'c3', replyTo: 'c2', createdAt: new Date('2026-08-16T00:02:00.000Z') })
        ]
      })

      const result = await comments.listForPage('p1')

      assert.equal(result.length, 1)
      assert.equal(result[0].replies[0].id, 'c2')
      assert.equal(result[0].replies[0].replies[0].id, 'c3')
    })

    it("uses the joined author's name when authorId is set", async () => {
      ;(globalThis as any).WIKI.db = makeFakeDb({
        selectRows: [row({ id: 'c1', authorId: 'u1', authorName: 'Alice', guestName: null })]
      })
      const result = await comments.listForPage('p1')
      assert.equal(result[0].authorName, 'Alice')
    })

    it('falls back to guestName when authorId is null, matching pageEditSubmissions-style rows', async () => {
      ;(globalThis as any).WIKI.db = makeFakeDb({
        selectRows: [
          row({ id: 'c1', authorId: null, authorName: null, guestName: 'Casual Visitor' })
        ]
      })
      const result = await comments.listForPage('p1')
      assert.equal(result[0].authorName, 'Casual Visitor')
    })

    it('drops a reply whose replyTo points at a comment absent from the result set, rather than surfacing it as an orphaned top-level comment', async () => {
      ;(globalThis as any).WIKI.db = makeFakeDb({
        // Simulates the state a deleted-and-cascaded parent would leave behind IF the cascade somehow
        // hadn't already removed this row too — it never should reach this method in practice, but the
        // tree-builder must not misrepresent it as a fresh top-level comment or throw.
        selectRows: [row({ id: 'c2', replyTo: 'deleted-parent-id' })]
      })

      const result = await comments.listForPage('p1')

      assert.deepEqual(result, [], 'the orphaned reply must not appear anywhere in the result')
    })
  })

  describe('countForPage', () => {
    it('returns 0 for a page with zero comments', async () => {
      ;(globalThis as any).WIKI.db = makeFakeDb({ countValue: 0 })
      assert.equal(await comments.countForPage('p1'), 0)
    })

    it('returns the count from the db, replies included', async () => {
      ;(globalThis as any).WIKI.db = makeFakeDb({ countValue: 5 })
      const total = await comments.countForPage('p1')
      assert.equal(total, 5)
      assert.equal(calls.counts.length, 1)
      assert.ok(calls.counts[0].where, 'expected a where clause scoping the count to the page')
    })
  })
})

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
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
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
