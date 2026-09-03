import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import * as Y from 'yjs'
import {
  pageDrafts as pageDraftsTable,
  pages as pagesTable,
  users as usersTable
} from '../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'

/**
 * `models/pageDrafts.ts` (OpenProject #2454 / #2455) is a thin upsert/select/delete layer over one
 * table, so it is exercised against a real database rather than mocked — the same reasoning
 * `rateLimits.test.ts` gives for its own DB-backed suite. Its actual behavioural promises (debounce,
 * which fallback tier `initRoom()` prefers, the `RELAYED`-origin no-op guard, attribution bookkeeping)
 * belong to `core/collab.*.test.ts` instead; this file only pins the storage layer those tests stub
 * out, plus the Yjs-state decode `getContent()` does for the recovery-restore route.
 */
describe('pageDrafts (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pageDraftsModel: typeof import('./pageDrafts.ts').pageDrafts
  let STALE_DRAFT_DAYS: number
  let pageId: string

  before(async () => {
    fixtures = await setupTestDb()
    ;({ pageDrafts: pageDraftsModel, STALE_DRAFT_DAYS } = await import('./pageDrafts.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  /**
   * A minimal, valid `pages` row for `pageDrafts.pageId`'s FK to reference — inserted directly rather
   * than through `models/pages.ts#createPage()`, which this suite has no other use for (no locale
   * seeding, no renderQueue stub). One fresh row per test, so `purgeStale()`'s and `clear()`'s tests
   * never see another test's leftover draft.
   */
  async function seedPage(): Promise<string> {
    const [row] = await fixtures.db
      .insert(pagesTable)
      .values({
        locale: 'en',
        path: `test/${crypto.randomUUID()}`,
        hash: crypto.randomUUID(),
        title: 'Draft test page',
        editor: 'markdown',
        contentType: 'markdown',
        authorId: fixtures.userId,
        creatorId: fixtures.userId,
        ownerId: fixtures.userId,
        siteId: fixtures.siteId,
        classification: fixtures.classificationId
      })
      .returning({ id: pagesTable.id })
    return row!.id
  }

  /** A real Yjs update carrying the given content/title/description/icon — what `core/collab.ts`
   * actually persists, and what `getContent()` has to decode back out. */
  function buildState(fields: {
    content?: string
    title?: string
    description?: string
    icon?: string
  }): Uint8Array {
    const doc = new Y.Doc()
    doc.transact(() => {
      doc.getText('content').insert(0, fields.content ?? '')
      const props = doc.getMap('props')
      props.set('title', fields.title ?? '')
      props.set('description', fields.description ?? '')
      props.set('icon', fields.icon ?? '')
    })
    const update = Y.encodeStateAsUpdate(doc)
    doc.destroy()
    return update
  }

  beforeEach(async () => {
    await fixtures.db.delete(pageDraftsTable)
    pageId = await seedPage()
  })

  test('get() answers undefined for a page with no draft', async () => {
    const draft = await pageDraftsModel.get(pageId)
    assert.equal(draft, undefined)
  })

  test('getContent()/summary() answer undefined for a page with no draft', async () => {
    assert.equal(await pageDraftsModel.getContent(pageId), undefined)
    assert.equal(await pageDraftsModel.summary(pageId), undefined)
  })

  test('save() then get() round-trips the exact raw Yjs bytes', async () => {
    const state = new Uint8Array([1, 2, 3, 4, 250])
    await pageDraftsModel.save(pageId, fixtures.siteId, state)

    const draft = await pageDraftsModel.get(pageId)
    assert.ok(draft)
    assert.deepEqual(new Uint8Array(draft.state), state)
    assert.ok(draft.updatedAt instanceof Date)
  })

  test('save() then getContent() decodes the stored Yjs state back into plain fields', async () => {
    const state = buildState({
      content: 'unsaved content',
      title: 'Unsaved Title',
      description: 'Unsaved description',
      icon: 'mdi:file'
    })
    await pageDraftsModel.save(pageId, fixtures.siteId, state, fixtures.userId, 'Ada Lovelace')

    const draft = await pageDraftsModel.getContent(pageId)
    assert.ok(draft)
    assert.equal(draft.content, 'unsaved content')
    assert.equal(draft.title, 'Unsaved Title')
    assert.equal(draft.description, 'Unsaved description')
    assert.equal(draft.icon, 'mdi:file')
    assert.equal(draft.authorName, 'Ada Lovelace')
    assert.ok(draft.updatedAt instanceof Date)
  })

  test('save() with no author leaves authorName null, and summary() reflects it', async () => {
    await pageDraftsModel.save(pageId, fixtures.siteId, buildState({ content: 'x' }))

    const summary = await pageDraftsModel.summary(pageId)
    assert.ok(summary)
    assert.equal(summary.authorName, null)
    assert.ok(summary.updatedAt instanceof Date)
    assert.equal(Object.hasOwn(summary, 'state'), false)
  })

  test('save() twice overwrites in place — one row per page, not a history', async () => {
    await pageDraftsModel.save(pageId, fixtures.siteId, new Uint8Array([1]))
    await pageDraftsModel.save(pageId, fixtures.siteId, new Uint8Array([2, 2]))

    const draft = await pageDraftsModel.get(pageId)
    assert.deepEqual(new Uint8Array(draft!.state), new Uint8Array([2, 2]))

    const rows = await fixtures.db
      .select()
      .from(pageDraftsTable)
      .where(eq(pageDraftsTable.pageId, pageId))
    assert.equal(rows.length, 1)
  })

  test('save() bumps updatedAt on an overwrite, not just the first insert', async () => {
    await pageDraftsModel.save(pageId, fixtures.siteId, new Uint8Array([1]))
    const [firstRow] = await fixtures.db
      .select({ updatedAt: pageDraftsTable.updatedAt })
      .from(pageDraftsTable)
      .where(eq(pageDraftsTable.pageId, pageId))
    // -> Backdated directly so the second save's bump is unambiguous against real wall-clock jitter.
    await fixtures.db
      .update(pageDraftsTable)
      .set({ updatedAt: new Date(Date.now() - 60_000) })
      .where(eq(pageDraftsTable.pageId, pageId))

    await pageDraftsModel.save(pageId, fixtures.siteId, new Uint8Array([2]))
    const [secondRow] = await fixtures.db
      .select({ updatedAt: pageDraftsTable.updatedAt })
      .from(pageDraftsTable)
      .where(eq(pageDraftsTable.pageId, pageId))

    assert.ok(secondRow!.updatedAt.getTime() > firstRow!.updatedAt.getTime() - 60_000)
    assert.ok(
      secondRow!.updatedAt.getTime() > Date.now() - 5_000,
      'the second save should have bumped updatedAt back to roughly now'
    )
  })

  test('clear() removes the row', async () => {
    await pageDraftsModel.save(pageId, fixtures.siteId, new Uint8Array([1]))
    await pageDraftsModel.clear(pageId)

    assert.equal(await pageDraftsModel.get(pageId), undefined)
  })

  test('clear() on a page with no draft is a safe no-op', async () => {
    await assert.doesNotReject(pageDraftsModel.clear(pageId))
  })

  test('deleting the page cascades to delete its draft', async () => {
    await pageDraftsModel.save(pageId, fixtures.siteId, new Uint8Array([1]))
    await fixtures.db.delete(pagesTable).where(eq(pagesTable.id, pageId))

    const rows = await fixtures.db
      .select()
      .from(pageDraftsTable)
      .where(eq(pageDraftsTable.pageId, pageId))
    assert.equal(rows.length, 0)
  })

  test('deleting the author account sets authorId null rather than blocking', async () => {
    const [author] = await fixtures.db
      .insert(usersTable)
      .values({
        email: `draft-author-${crypto.randomUUID()}@example.com`,
        name: 'Temp Author'
      })
      .returning({ id: usersTable.id })
    await pageDraftsModel.save(
      pageId,
      fixtures.siteId,
      new Uint8Array([1]),
      author!.id,
      'Temp Author'
    )

    await fixtures.db.delete(usersTable).where(eq(usersTable.id, author!.id))

    const [row] = await fixtures.db
      .select({ authorId: pageDraftsTable.authorId })
      .from(pageDraftsTable)
      .where(eq(pageDraftsTable.pageId, pageId))
    assert.equal(row!.authorId, null)
  })

  test('purgeStale() drops only rows untouched for over STALE_DRAFT_DAYS', async () => {
    const stalePageId = await seedPage()
    await pageDraftsModel.save(pageId, fixtures.siteId, new Uint8Array([1])) // fresh
    await pageDraftsModel.save(stalePageId, fixtures.siteId, new Uint8Array([2]))
    await fixtures.db
      .update(pageDraftsTable)
      .set({
        updatedAt: new Date(Date.now() - (STALE_DRAFT_DAYS + 1) * 24 * 60 * 60 * 1000)
      })
      .where(eq(pageDraftsTable.pageId, stalePageId))

    const purged = await pageDraftsModel.purgeStale()
    assert.ok(purged >= 1)

    assert.notEqual(await pageDraftsModel.get(pageId), undefined, 'a fresh draft must survive')
    assert.equal(await pageDraftsModel.get(stalePageId), undefined, 'a stale draft must be purged')
  })

  test('purgeStale() leaves a draft just inside the retention window alone', async () => {
    await pageDraftsModel.save(pageId, fixtures.siteId, new Uint8Array([1]))
    await fixtures.db
      .update(pageDraftsTable)
      .set({
        updatedAt: new Date(Date.now() - (STALE_DRAFT_DAYS - 1) * 24 * 60 * 60 * 1000)
      })
      .where(eq(pageDraftsTable.pageId, pageId))

    await pageDraftsModel.purgeStale()

    assert.notEqual(await pageDraftsModel.get(pageId), undefined)
  })
})
