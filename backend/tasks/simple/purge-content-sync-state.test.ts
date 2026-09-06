import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../../test/db.ts'
import {
  contentSyncState as contentSyncStateTable,
  storage as storageTable
} from '../../db/schema.ts'
import { task } from './purge-content-sync-state.ts'

/**
 * Exercises the real sweep end to end against Postgres -- the point of this task is a genuine
 * `DELETE ... WHERE NOT EXISTS (...)`, which a mock of the model would not actually verify. Gated
 * on `DATABASE_URL` per CLAUDE.md's DB-backed testing convention.
 */
describe('purge-content-sync-state task', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let targetId: string
  let pageId: string
  let orphanId: string

  before(async () => {
    fixtures = await setupTestDb()

    const [target] = await fixtures.db
      .insert(storageTable)
      .values({ siteId: fixtures.siteId, module: 'test-purge-content-sync-state' })
      .returning({ id: storageTable.id })
    targetId = target!.id

    const pagesModel = (await import('../../models/pages.ts')).pages
    const page = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'purge-content-sync-state-live',
        title: 'Live Page',
        editor: 'markdown',
        content: 'x'
      },
      { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    )
    pageId = page.id
    orphanId = randomUUID()

    // -> One row pointing at a page that still exists, one pointing at a page that never existed
    //    (standing in for one whose page has since been deleted) -- the task must remove only the
    //    latter.
    await fixtures.db.insert(contentSyncStateTable).values([
      { contentType: 'page', contentId: pageId, targetId, lastError: null },
      { contentType: 'page', contentId: orphanId, targetId, lastError: null }
    ])
  })

  after(async () => {
    await teardownTestDb()
  })

  test('removes only the row whose page no longer exists, and reports the count it swept', async () => {
    // -> OpenProject #2672: the count is RETURNED, not logged. `core/scheduler.ts#runJob` is what
    //    turns it into this run's one `info` line, with the job id and duration attached.
    const outcome = await task()
    assert.deepEqual(outcome, { summary: 'purged orphaned contentSyncState rows', purged: 1 })

    const rows = await fixtures.db
      .select({ contentId: contentSyncStateTable.contentId })
      .from(contentSyncStateTable)
      .where(eq(contentSyncStateTable.targetId, targetId))
    const remaining = rows.map((r) => r.contentId)

    assert.ok(remaining.includes(pageId), 'the live page row should survive')
    assert.ok(!remaining.includes(orphanId), 'the orphaned row should be removed')
  })
})
