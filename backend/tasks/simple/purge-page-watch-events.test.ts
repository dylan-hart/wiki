import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { eq, sql } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../../test/db.ts'
import { pageWatchEvents as pageWatchEventsTable, users as usersTable } from '../../db/schema.ts'
import type { PageActor, PageInput } from '../../models/pages.ts'

describe('purge-page-watch-events task', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let task: typeof import('./purge-page-watch-events.ts').task
  let pagesModel: typeof import('../../models/pages.ts').pages
  let actor: PageActor
  let pageId: string
  let siteId: string
  let userId: string

  before(async () => {
    fixtures = await setupTestDb()
    siteId = fixtures.siteId
    userId = fixtures.userId
    ;({ task } = await import('./purge-page-watch-events.ts'))
    ;({ pages: pagesModel } = await import('../../models/pages.ts'))
    actor = { id: fixtures.userId, groupIds: [], permissions: ['manage:system'] }

    const page = await pagesModel.createPage(
      siteId,
      {
        path: 'purge-watch-events-fixture',
        title: 'Purge Fixture',
        editor: 'markdown',
        content: '# Hi'
      } as PageInput,
      actor
    )
    pageId = page.id
  })

  after(async () => {
    await teardownTestDb()
  })

  test('removes rows past the retention window and keeps recent ones, regardless of delivery state', async () => {
    await fixtures.db.insert(pageWatchEventsTable).values([
      {
        siteId,
        pageId,
        pageTitle: 'Purge Fixture',
        pagePath: 'purge-watch-events-fixture',
        pageLocale: 'en',
        userId,
        action: 'updated',
        changedFields: ['title'],
        notifyMode: 'digest',
        createdAt: sql`now() - interval '120 days'`
      },
      {
        siteId,
        pageId,
        pageTitle: 'Purge Fixture',
        pagePath: 'purge-watch-events-fixture',
        pageLocale: 'en',
        userId,
        action: 'moved',
        changedFields: ['path'],
        notifyMode: 'immediate',
        createdAt: sql`now() - interval '91 days'`,
        deliveredAt: sql`now() - interval '90 days'`,
        readAt: sql`now() - interval '90 days'`
      },
      {
        siteId,
        pageId,
        pageTitle: 'Purge Fixture',
        pagePath: 'purge-watch-events-fixture',
        pageLocale: 'en',
        userId,
        action: 'updated',
        changedFields: ['title'],
        notifyMode: 'digest',
        createdAt: sql`now() - interval '1 day'`
      },
      {
        siteId,
        pageId,
        pageTitle: 'Purge Fixture',
        pagePath: 'purge-watch-events-fixture',
        pageLocale: 'en',
        userId,
        action: 'updated',
        changedFields: ['title'],
        notifyMode: 'immediate',
        createdAt: sql`now() - interval '1 hour'`,
        deliveredAt: sql`now()`
      }
    ] as any)

    const outcome = await task()
    assert.equal(
      (outcome as { summary: string }).summary,
      'purged page watch events past the retention window'
    )

    const remaining = await fixtures.db
      .select({ action: pageWatchEventsTable.action, createdAt: pageWatchEventsTable.createdAt })
      .from(pageWatchEventsTable)
      .where(eq(pageWatchEventsTable.pageId, pageId))
    const remainingActions = remaining.map((r) => r.action)

    assert.equal(remaining.length, 2, 'only the two recent rows should survive the purge')
    assert.deepEqual([...remainingActions].sort(), ['updated', 'updated'])
  })

  test('is a no-op when nothing is old enough to purge', async () => {
    const freshUser = await (async () => {
      const [row] = await fixtures.db
        .insert(usersTable)
        .values({
          email: 'purge-noop@example.com',
          name: 'Purge Noop',
          isActive: true,
          isVerified: true
        })
        .returning({ id: usersTable.id })
      return row!.id
    })()
    await fixtures.db.insert(pageWatchEventsTable).values([
      {
        siteId,
        pageId,
        pageTitle: 'Purge Fixture',
        pagePath: 'purge-watch-events-fixture',
        pageLocale: 'en',
        userId: freshUser,
        action: 'updated',
        changedFields: ['title'],
        notifyMode: 'digest',
        createdAt: sql`now()`
      }
    ] as any)

    await assert.doesNotReject(() => task())

    const remaining = await fixtures.db
      .select({ id: pageWatchEventsTable.id })
      .from(pageWatchEventsTable)
      .where(eq(pageWatchEventsTable.userId, freshUser))
    assert.equal(remaining.length, 1)
  })
})
