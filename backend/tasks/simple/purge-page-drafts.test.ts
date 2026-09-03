import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { eq } from 'drizzle-orm'
import {
  hasTestDatabase,
  seedLocale,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../../test/db.ts'
import { pageDrafts as pageDraftsTable, pages as pagesTable } from '../../db/schema.ts'
import { pageDrafts } from '../../models/pageDrafts.ts'
import { task } from './purge-page-drafts.ts'

/**
 * `purge-page-drafts` task: the retention sweep behind `models/pageDrafts.ts#purgeStale()` (Feature
 * #2426), exercised through the task wrapper for the same "Done when" reason
 * `purge-page-watch-events.test.ts` gives -- and so a real failure inside `purgeStale()` surfaces as
 * a thrown/logged error from `task()`, not just a model-level assertion.
 */
describe('purge-page-drafts task', { skip: !hasTestDatabase() }, () => {
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

  async function makePage(path: string): Promise<string> {
    const [row] = await fixtures.db
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

  test('drops stale drafts and leaves recent ones, without throwing', async () => {
    const staleId = await makePage('purge-page-drafts/stale')
    const freshId = await makePage('purge-page-drafts/fresh')
    await pageDrafts.save(staleId, siteId, new Uint8Array([1]))
    await pageDrafts.save(freshId, siteId, new Uint8Array([2]))
    await fixtures.db
      .update(pageDraftsTable)
      .set({ updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
      .where(eq(pageDraftsTable.pageId, staleId))

    await task()

    assert.equal(await pageDrafts.get(staleId), null)
    assert.ok(await pageDrafts.get(freshId))
  })

  test('is a no-op when nothing is old enough to purge', async () => {
    const pageId = await makePage('purge-page-drafts/noop')
    await pageDrafts.save(pageId, siteId, new Uint8Array([3]))

    await task()

    assert.ok(await pageDrafts.get(pageId))
  })
})
