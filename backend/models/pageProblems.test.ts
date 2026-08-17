import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { pages as pagesTable, tree as treeTable } from '../db/schema.ts'

/**
 * `scan` is four independent SQL-backed checks over `pages`/`tree`, each of which needs data that
 * genuinely violates an invariant the normal write path (`models/pages.ts`, `models/tree.ts`) always
 * upholds — a drifted hash, a page with no tree entry, two pages at the same path, a relation
 * pointing nowhere. None of that is reachable through the model layer on purpose, so each scenario is
 * set up with a direct `db` write, same reasoning as `models/export.test.ts` for running against a
 * real, migrated database rather than mocking the query builder.
 */
describe('pageProblems.scan (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pageProblemsModel: typeof import('./pageProblems.ts').pageProblems
  let pagesModel: typeof import('./pages.ts').pages

  before(async () => {
    fixtures = await setupTestDb()
    ;({ pageProblems: pageProblemsModel } = await import('./pageProblems.ts'))
    ;({ pages: pagesModel } = await import('./pages.ts'))
  })

  after(async () => {
    await teardownTestDb()
  })

  test('scan reports nothing wrong with pages created through the model', async () => {
    await pagesModel.createPage(
      fixtures.siteId,
      { path: 'clean-page', title: 'Clean Page', editor: 'markdown', content: '# Fine' },
      { id: fixtures.userId, permissions: ['manage:system'] }
    )

    const report = await pageProblemsModel.scan()

    assert.equal(
      report.hashDrift.entries.some((e) => e.path === 'clean-page'),
      false
    )
    assert.equal(
      report.treeDivergence.entries.some((e) => e.path === 'clean-page'),
      false
    )
    assert.equal(
      report.duplicatePaths.entries.some((e) => e.path === 'clean-page'),
      false
    )
    assert.equal(
      report.brokenRelations.entries.some((e) => e.path === 'clean-page'),
      false
    )
    assert.match(report.scannedAt, /^\d{4}-\d{2}-\d{2}T/)
  })

  test('scan catches a drifted hash', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'drifted-hash', title: 'Drifted Hash', editor: 'markdown', content: '# Fine' },
      { id: fixtures.userId, permissions: ['manage:system'] }
    )
    await fixtures.db
      .update(pagesTable)
      .set({ hash: 'not-the-real-hash' })
      .where(eq(pagesTable.id, page.id))

    const report = await pageProblemsModel.scan()

    const entry = report.hashDrift.entries.find((e) => e.id === page.id)
    assert.ok(entry)
    assert.equal(entry!.storedHash, 'not-the-real-hash')
    assert.equal(entry!.expectedHash, page.hash)
  })

  test('scan catches a tree entry with no matching page (orphanTreeEntry)', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'orphan-tree', title: 'Orphan Tree', editor: 'markdown', content: '# Fine' },
      { id: fixtures.userId, permissions: ['manage:system'] }
    )
    // -> Deletes only the pages row, bypassing tree cleanup — exactly the divergence this check
    //    exists for, since there is no FK to prevent it
    await fixtures.db.delete(pagesTable).where(eq(pagesTable.id, page.id))

    const report = await pageProblemsModel.scan()

    const entry = report.treeDivergence.entries.find((e) => e.id === page.id)
    assert.ok(entry)
    assert.equal(entry!.direction, 'orphanTreeEntry')
    assert.equal(entry!.path, 'orphan-tree')
  })

  test('scan catches a page with no matching tree entry (orphanPageRow)', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'orphan-page', title: 'Orphan Page', editor: 'markdown', content: '# Fine' },
      { id: fixtures.userId, permissions: ['manage:system'] }
    )
    await fixtures.db.delete(treeTable).where(eq(treeTable.id, page.id))

    const report = await pageProblemsModel.scan()

    const entry = report.treeDivergence.entries.find((e) => e.id === page.id)
    assert.ok(entry)
    assert.equal(entry!.direction, 'orphanPageRow')
    assert.equal(entry!.path, 'orphan-page')
  })

  test('scan catches duplicate (siteId, locale, path) tuples', async () => {
    const common = {
      locale: 'en',
      path: 'duplicate-path',
      hash: 'irrelevant-for-this-check',
      title: 'Duplicate Path',
      editor: 'markdown',
      contentType: 'markdown',
      authorId: fixtures.userId,
      creatorId: fixtures.userId,
      ownerId: fixtures.userId,
      siteId: fixtures.siteId
    }
    // -> Two rows sharing a (siteId, locale, path) — reachable only by writing under the model layer,
    //    since `createPage` itself refuses this
    const inserted = await fixtures.db.insert(pagesTable).values([common, common]).returning()

    const report = await pageProblemsModel.scan()

    const group = report.duplicatePaths.entries.find((e) => e.path === 'duplicate-path')
    assert.ok(group)
    assert.equal(group!.locale, 'en')
    assert.deepEqual([...group!.pageIds].sort(), inserted.map((p) => p.id).sort())
  })

  test('scan catches a relation pointing at a page that no longer exists', async () => {
    const target = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'relation-target', title: 'Relation Target', editor: 'markdown', content: '# Fine' },
      { id: fixtures.userId, permissions: ['manage:system'] }
    )
    const source = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'relation-source',
        title: 'Relation Source',
        editor: 'markdown',
        content: '# Fine',
        relations: [
          {
            id: 'rel-1',
            position: 'left',
            label: 'Gone',
            icon: 'la:link',
            target: '/no-such-page'
          },
          {
            id: 'rel-2',
            position: 'left',
            label: 'Fine',
            icon: 'la:link',
            target: '/relation-target'
          },
          {
            id: 'rel-3',
            position: 'left',
            label: 'External',
            icon: 'la:link',
            target: 'https://example.com'
          }
        ]
      },
      { id: fixtures.userId, permissions: ['manage:system'] }
    )
    assert.ok(target.id)

    const report = await pageProblemsModel.scan()

    const broken = report.brokenRelations.entries.filter((e) => e.pageId === source.id)
    assert.equal(broken.length, 1)
    assert.equal(broken[0]!.relationId, 'rel-1')
    assert.equal(broken[0]!.target, '/no-such-page')
  })
})
