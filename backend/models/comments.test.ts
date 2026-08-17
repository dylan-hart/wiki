import assert from 'node:assert/strict'
import { before, beforeEach, describe, it } from 'node:test'

// Node 26 (this repo's target runtime, per CLAUDE.md) provides `Temporal` as a native global. This
// dev environment runs an older Node without it, so shim just enough of `Temporal.Now.instant()` for
// `comments.update()` — which genuinely calls the real global, unmodified — to run here too.
if (typeof (globalThis as any).Temporal === 'undefined') {
  ;(globalThis as any).Temporal = {
    Now: { instant: () => ({ epochMilliseconds: Date.now() }) }
  }
}

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
 */
function makeFakeDb(config: { selectRows?: unknown[]; countValue?: number } = {}) {
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
            return [{ id: 'existing-comment-id', ...set }]
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

before(async () => {
  ;(globalThis as any).WIKI = { db: makeFakeDb() }
  ;({ comments } = await import('./comments.ts'))
})

beforeEach(() => {
  calls.inserts.length = 0
  calls.updates.length = 0
  calls.deletes.length = 0
  calls.selects.length = 0
  calls.counts.length = 0
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

describe('comments model — create', () => {
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
})

describe('comments model — update', () => {
  it('rejects content trimmed below 2 characters and does not touch the db', async () => {
    await assert.rejects(() => comments.update('c1', { content: 'x' }), /at least 2 characters/)
    assert.equal(calls.updates.length, 0)
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
})

describe('comments model — delete', () => {
  it('issues a delete scoped by a where clause', async () => {
    await comments.delete('c1')
    assert.equal(calls.deletes.length, 1)
    assert.ok(calls.deletes[0].where, 'expected a where clause to scope the delete')
  })
})

describe('comments model — listForPage', () => {
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
      selectRows: [row({ id: 'c1', authorId: null, authorName: null, guestName: 'Casual Visitor' })]
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

describe('comments model — countForPage', () => {
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
