import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { groups as groupsTable } from '../db/schema.ts'
import type { PageActor, PageInput } from './pages.ts'
import type { AccessActor, GroupRule } from './groups.ts'

/**
 * DB-backed test for `tags.getPopularTags()` (OpenProject #3046): "Popular Tags", capped to 10,
 * ranked by 60-day content activity rather than `getTags()`'s all-time usage count.
 *
 * Runs the real query against a real, migrated database (see `test/db.ts`) because the thing under
 * test IS the SQL — the recency filter and the aggregation — not something a mock of the query
 * builder would verify. `createPage()`'s `createdAt`/`updatedAt` overrides are what let a single test
 * simulate "old, heavily-tagged content" vs. "recently active content" without waiting real time.
 */
describe('tags.getPopularTags() (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pagesModel: typeof import('./pages.ts').pages
  let groupsModel: typeof import('./groups.ts').groups
  let tagsModel: typeof import('./tags.ts').tags
  let actor: PageActor

  before(async () => {
    fixtures = await setupTestDb()
    ;({ pages: pagesModel } = await import('./pages.ts'))
    ;({ groups: groupsModel } = await import('./groups.ts'))
    ;({ tags: tagsModel } = await import('./tags.ts'))
    actor = { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
  })

  after(async () => {
    await teardownTestDb()
  })

  function pageInput(overrides: Partial<PageInput> = {}): PageInput {
    return {
      path: 'page',
      title: 'Page',
      editor: 'markdown',
      content: 'x',
      ...overrides
    }
  }

  const OLD_TIMESTAMP = '2020-01-01T00:00:00.000Z'

  test('ranks by recent activity, not all-time usage count', async () => {
    // -> 'stale' carries three old pages nobody has touched in years; 'fresh' carries just one,
    //    updated moments ago. All-time usage would rank 'stale' first -- 60-day activity must not.
    for (const path of ['stale-a', 'stale-b', 'stale-c']) {
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({
          path: `activity/${path}`,
          tags: ['stale'],
          createdAt: OLD_TIMESTAMP,
          updatedAt: OLD_TIMESTAMP
        }),
        actor
      )
    }
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'activity/fresh-a', tags: ['fresh'] }),
      actor
    )

    const popular = await tagsModel.getPopularTags(fixtures.siteId)

    assert.deepEqual(
      popular.map((t) => t.tag),
      ['fresh']
    )
    assert.equal(popular[0]!.usageCount, 1)
  })

  test('caps at the limit, most active first', async () => {
    for (let i = 0; i < 12; i++) {
      await pagesModel.createPage(
        fixtures.siteId,
        pageInput({ path: `cap/page-${i}`, tags: [`cap-tag-${i}`, 'shared'] }),
        actor
      )
    }

    const popular = await tagsModel.getPopularTags(fixtures.siteId, { limit: 10 })

    assert.equal(popular.length, 10)
    // -> 'shared' is carried by all 12 pages -- the most active tag -- and must sort first.
    assert.equal(popular[0]!.tag, 'shared')
    assert.equal(popular[0]!.usageCount, 12)
  })

  test('an actor only counts pages they may read, and only within the recency window', async () => {
    const rule = (overrides: Partial<GroupRule> = {}): GroupRule => ({
      id: 'rule-1',
      name: 'Test Rule',
      roles: ['read:pages'],
      match: 'START',
      mode: 'ALLOW',
      path: '',
      locales: [],
      sites: [],
      ...overrides
    })

    // -> Readable + recent: counts.
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'scoped/readable-recent', tags: ['scoped-tag'] }),
      actor
    )
    // -> Readable but stale: must not count even though the actor may read it.
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({
        path: 'scoped/readable-stale',
        tags: ['scoped-tag'],
        createdAt: OLD_TIMESTAMP,
        updatedAt: OLD_TIMESTAMP
      }),
      actor
    )
    // -> Recent but outside the actor's readable scope: must not count even though it is active.
    await pagesModel.createPage(
      fixtures.siteId,
      pageInput({ path: 'unscoped/recent-but-unreadable', tags: ['scoped-tag'] }),
      actor
    )

    await fixtures.db
      .update(groupsTable)
      .set({ rules: [rule({ path: 'scoped' })] })
      .where(eq(groupsTable.id, fixtures.groupId))
    await groupsModel.reloadCache()

    const scopedActor: AccessActor = { groupIds: [fixtures.groupId], permissions: [] }
    const popular = await tagsModel.getPopularTags(fixtures.siteId, { actor: scopedActor })

    assert.equal(popular.length, 1)
    assert.equal(popular[0]!.tag, 'scoped-tag')
    assert.equal(popular[0]!.usageCount, 1)
  })
})
