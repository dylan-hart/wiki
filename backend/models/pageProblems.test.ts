import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import {
  hasTestDatabase,
  seedLocale,
  seedTreeEntry,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../test/db.ts'
import { pages as pagesTable, tree as treeTable } from '../db/schema.ts'
import { ensureTemporal } from '../test/temporal.ts'

// `scan()` (in pageProblems.ts) calls `Temporal.Now.instant()` unconditionally to stamp `scannedAt` --
// see `test/temporal.ts` for why this is needed at all.
await ensureTemporal()

/**
 * `scan` is five independent SQL-backed checks over `pages`/`tree`, each of which needs data that
 * genuinely violates an invariant the normal write path (`models/pages.ts`, `models/tree.ts`) always
 * upholds — a drifted hash, a page with no tree entry, two pages at the same path, a relation
 * pointing nowhere, a path starting with an installed locale code. None of that is reachable through
 * the model layer on purpose (the last one as of task 12/#994), so each scenario is set up with a
 * direct `db` write, same reasoning as `models/export.test.ts` for running against a real, migrated
 * database rather than mocking the query builder.
 */
describe('pageProblems.scan (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let pageProblemsModel: typeof import('./pageProblems.ts').pageProblems
  let pagesModel: typeof import('./pages.ts').pages

  before(async () => {
    fixtures = await setupTestDb()
    // -> Installed (not merely active-on-site) locale codes for the localeCollisions check below —
    //    seeded before any model call, so the first `getLocales()` cache fill already sees them.
    await seedLocale(fixtures.db, { code: 'en' })
    await seedLocale(fixtures.db, { code: 'fr' })
    // -> Mixed-cased on purpose (`localeCode` in `models/locales.ts` produces exactly this shape for
    //   a region-qualified language, e.g. `pt-BR`) -- the collidingCode canonical-casing test below
    //   needs an installed code whose casing actually differs from the lowercased path segment.
    await seedLocale(fixtures.db, { code: 'fr-CA' })
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
      { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
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
      { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
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
      { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
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
      { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    )
    await fixtures.db.delete(treeTable).where(eq(treeTable.id, page.id))

    const report = await pageProblemsModel.scan()

    const entry = report.treeDivergence.entries.find((e) => e.id === page.id)
    assert.ok(entry)
    assert.equal(entry!.direction, 'orphanPageRow')
    assert.equal(entry!.path, 'orphan-page')
  })

  test('the database itself now prevents a duplicate (siteId, locale, path) tuple, so scan reports none in the normal case', async () => {
    // -> `pages_siteId_locale_path_idx` (added by an earlier task, `db/schema.ts`) rejects this at
    //    the database level even writing directly under the model layer -- there is no longer a way
    //    to fabricate a genuine duplicate to feed this check. `duplicatePaths` stays in `scan()` as
    //    defense-in-depth regardless (same category as `hashDrift`: an invariant the write path
    //    upholds today, not proof nothing could ever violate it — e.g. a constraint dropped or
    //    bypassed by a future migration/import), so this test now covers the DB-level guarantee that
    //    makes it currently unreachable, plus the clean-report case.
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
      siteId: fixtures.siteId,
      classification: fixtures.classificationId
    }
    await fixtures.db.insert(pagesTable).values(common)
    await assert.rejects(
      fixtures.db.insert(pagesTable).values(common),
      (err: any) => (err.cause?.code ?? err.code) === '23505'
    )

    const report = await pageProblemsModel.scan()

    assert.equal(
      report.duplicatePaths.entries.some((e) => e.path === 'duplicate-path'),
      false
    )
  })

  test('scan catches a relation pointing at a page that no longer exists', async () => {
    const target = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'relation-target', title: 'Relation Target', editor: 'markdown', content: '# Fine' },
      { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
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
      { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    )
    assert.ok(target.id)

    const report = await pageProblemsModel.scan()

    const broken = report.brokenRelations.entries.filter((e) => e.pageId === source.id)
    assert.equal(broken.length, 1)
    assert.equal(broken[0]!.relationId, 'rel-1')
    assert.equal(broken[0]!.target, '/no-such-page')
  })

  test('scan catches a grandfathered pages row whose path starts with an installed locale code', async () => {
    // -> `createPage()` refuses this outright since task 12/#994 — reachable only by writing under
    //    the model layer, exactly the "grandfathered" row this check exists to surface.
    const [row] = await fixtures.db
      .insert(pagesTable)
      .values({
        locale: 'en',
        path: 'fr/grandfathered',
        hash: 'irrelevant-for-this-check',
        title: 'Grandfathered',
        editor: 'markdown',
        contentType: 'markdown',
        authorId: fixtures.userId,
        creatorId: fixtures.userId,
        ownerId: fixtures.userId,
        siteId: fixtures.siteId,
        classification: fixtures.classificationId
      })
      .returning()

    const report = await pageProblemsModel.scan()

    const entry = report.localeCollisions.entries.find((e) => e.id === row!.id)
    assert.ok(entry)
    assert.equal(entry!.table, 'pages')
    assert.equal(entry!.path, 'fr/grandfathered')
    assert.equal(entry!.collidingCode, 'fr')
  })

  test('scan catches a grandfathered root tree folder named after an installed locale code', async () => {
    // -> `tree.createFolder()` refuses this outright since task 12/#994 — same reasoning as above.
    const folder = await seedTreeEntry(fixtures.db, {
      siteId: fixtures.siteId,
      path: 'fr',
      type: 'folder',
      locale: 'en'
    })

    const report = await pageProblemsModel.scan()

    const entry = report.localeCollisions.entries.find((e) => e.id === folder.id)
    assert.ok(entry)
    assert.equal(entry!.table, 'tree')
    assert.equal(entry!.path, 'fr')
    assert.equal(entry!.collidingCode, 'fr')
  })

  test('scan catches a grandfathered tree row nested under a reserved-code root, even without a folder row for it', async () => {
    const child = await seedTreeEntry(fixtures.db, {
      siteId: fixtures.siteId,
      path: 'fr/nested-grandfathered',
      type: 'page',
      locale: 'en'
    })

    const report = await pageProblemsModel.scan()

    const entry = report.localeCollisions.entries.find((e) => e.id === child.id)
    assert.ok(entry)
    assert.equal(entry!.table, 'tree')
    assert.equal(entry!.path, 'fr/nested-grandfathered')
    assert.equal(entry!.collidingCode, 'fr')
  })

  test("scan reports collidingCode in the installed code's own casing, not the lowercased path segment", async () => {
    const [row] = await fixtures.db
      .insert(pagesTable)
      .values({
        locale: 'en',
        // -> Stored lowercased, same as every page path (`normalizePagePath`) -- `fr-CA` is
        //   installed, so this collides even though nothing here is mixed-case itself.
        path: 'fr-ca/grandfathered',
        hash: 'irrelevant-for-this-check-2',
        title: 'Grandfathered Mixed Case',
        editor: 'markdown',
        contentType: 'markdown',
        authorId: fixtures.userId,
        creatorId: fixtures.userId,
        ownerId: fixtures.userId,
        siteId: fixtures.siteId
      })
      .returning()

    const report = await pageProblemsModel.scan()

    const entry = report.localeCollisions.entries.find((e) => e.id === row!.id)
    assert.ok(entry)
    assert.equal(entry!.path, 'fr-ca/grandfathered')
    assert.equal(entry!.collidingCode, 'fr-CA')
  })

  test('scan does not flag a normal page or tree row', async () => {
    await pagesModel.createPage(
      fixtures.siteId,
      { path: 'docs/not-a-collision', title: 'Fine', editor: 'markdown', content: '# Fine' },
      { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    )

    const report = await pageProblemsModel.scan()

    assert.equal(
      report.localeCollisions.entries.some((e) => e.path === 'docs/not-a-collision'),
      false
    )
  })
})
