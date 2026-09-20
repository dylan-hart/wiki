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

    // -> The second row's `contentId` never named a real page, standing in for one whose page has
    //    since been deleted.
    await fixtures.db.insert(contentSyncStateTable).values([
      { contentType: 'page', contentId: pageId, targetId, lastError: null },
      { contentType: 'page', contentId: orphanId, targetId, lastError: null }
    ])
  })

  after(async () => {
    await teardownTestDb()
  })

  test('removes only the row whose page no longer exists, and reports the count it swept', async () => {
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
