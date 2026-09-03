import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { pageDrafts as pageDraftsTable, pages as pagesTable } from '../db/schema.ts'
import {
  hasTestDatabase,
  seedLocale,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../test/db.ts'
import { pageDrafts } from './pageDrafts.ts'

/**
 * Exercises `models/pageDrafts.ts` against a real Postgres instance -- the model is nothing but an
 * upsert-by-`pageId`, a read and a TTL sweep, exactly the kind of thing a mock of the query builder
 * would mostly just be re-describing rather than verifying (CLAUDE.md's guidance on when a DB-backed
 * test earns its cost). The room-restore behaviour this table exists to support (Feature #2426,
 * "crash/tab-close mid-edit does not lose content") is covered against this same real persistence in
 * `core/collab.draftPersistence.test.ts`, which stubs this model in-memory for speed; this file is
 * what proves the real thing the stub stands in for actually behaves the same way.
 *
 * Skipped unless `DATABASE_URL` is set -- see `test/db.ts`.
 */
describe('pageDrafts model (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let siteId: string
  let userId: string
  let classificationId: string

  before(async () => {
    fixtures = await setupTestDb()
    await seedLocale(fixtures.db, { code: 'en' })
    siteId = fixtures.siteId
    userId = fixtures.userId
    classificationId = fixtures.classificationId
  })

  after(async () => {
    await teardownTestDb()
  })

  /** Inserts a page owned by the fixture site/user, returning its id. */
  async function makePage(path: string): Promise<string> {
    const [row] = await WIKI.db
      .insert(pagesTable)
      .values({
        siteId,
        locale: 'en',
        path,
        hash: path,
        title: path,
        editor: 'markdown',
        contentType: 'markdown',
        authorId: userId,
        creatorId: userId,
        ownerId: userId,
        classification: classificationId
      })
      .returning({ id: pagesTable.id })
    return row.id
  }

  test('get() answers null for a page with no persisted draft', async () => {
    const pageId = await makePage('page-drafts/none')
    assert.equal(await pageDrafts.get(pageId), null)
  })

  test('save() then get() round-trips the exact bytes', async () => {
    const pageId = await makePage('page-drafts/roundtrip')
    const state = new Uint8Array([1, 2, 3, 4, 250, 251, 252])
    await pageDrafts.save(pageId, siteId, state)

    const readBack = await pageDrafts.get(pageId)
    assert.ok(readBack)
    assert.deepEqual(new Uint8Array(readBack), state)
  })

  test('save() twice on the same page upserts, leaving exactly one row with the latest state', async () => {
    const pageId = await makePage('page-drafts/upsert')
    await pageDrafts.save(pageId, siteId, new Uint8Array([1]))
    await pageDrafts.save(pageId, siteId, new Uint8Array([2, 2]))

    const rows = await WIKI.db
      .select()
      .from(pageDraftsTable)
      .where(eq(pageDraftsTable.pageId, pageId))
    assert.equal(rows.length, 1)
    assert.deepEqual(new Uint8Array(rows[0].state), new Uint8Array([2, 2]))
  })

  test('clear() drops the row, and is a safe no-op when there was none', async () => {
    const pageId = await makePage('page-drafts/clear')
    await pageDrafts.save(pageId, siteId, new Uint8Array([9]))
    assert.ok(await pageDrafts.get(pageId))

    await pageDrafts.clear(pageId)
    assert.equal(await pageDrafts.get(pageId), null)

    // -> Clearing again, with nothing left to clear, must not throw
    await pageDrafts.clear(pageId)
  })

  test('deleting the page cascades to its draft row (onDelete: cascade)', async () => {
    const pageId = await makePage('page-drafts/cascade')
    await pageDrafts.save(pageId, siteId, new Uint8Array([7]))

    await WIKI.db.delete(pagesTable).where(eq(pagesTable.id, pageId))

    const rows = await WIKI.db
      .select()
      .from(pageDraftsTable)
      .where(eq(pageDraftsTable.pageId, pageId))
    assert.equal(rows.length, 0)
  })

  test('purgeStale() drops only rows past the retention window', async () => {
    const freshId = await makePage('page-drafts/purge-fresh')
    const staleId = await makePage('page-drafts/purge-stale')
    await pageDrafts.save(freshId, siteId, new Uint8Array([1]))
    await pageDrafts.save(staleId, siteId, new Uint8Array([2]))
    await WIKI.db
      .update(pageDraftsTable)
      .set({ updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
      .where(eq(pageDraftsTable.pageId, staleId))

    const purged = await pageDrafts.purgeStale()
    assert.equal(purged, 1)
    assert.ok(await pageDrafts.get(freshId))
    assert.equal(await pageDrafts.get(staleId), null)
  })
})
