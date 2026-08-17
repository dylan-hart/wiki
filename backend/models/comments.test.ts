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

const calls: {
  inserts: RecordedInsert[]
  updates: RecordedUpdate[]
  deletes: RecordedDelete[]
} = { inserts: [], updates: [], deletes: [] }

function makeFakeDb() {
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
    })
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
  ;(globalThis as any).WIKI.db = makeFakeDb()
})

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
