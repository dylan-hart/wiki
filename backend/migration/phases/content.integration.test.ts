import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { and, eq } from 'drizzle-orm'
import {
  navigation as navigationTable,
  pageHistory as pageHistoryTable,
  pages as pagesTable,
  tree as treeTable
} from '../../db/schema.ts'
import { hasTestDatabase, seedTreeEntry, setupTestDb, teardownTestDb } from '../../test/db.ts'
import { contentPhase } from './content.ts'
import type { TestFixtures } from '../../test/db.ts'
import type { SourceConnector, SourceRecord } from '../connector.ts'
import type { MigrationContext } from '../context.ts'
import { iterate as iter, stubSourceConnector } from '../../test/migrationFixtures.ts'

/** A minimal `SourceConnector`: real `pages()`/`pageHistory()`/`navigation()` generators, everything
 * else a `NotYetImplementedError` stub since `contentPhase` never reads them. */
function fakeSourceConnector(): SourceConnector {
  return stubSourceConnector({
    pages: () =>
      iter<SourceRecord>([
        {
          id: 1,
          path: 'welcome',
          localeCode: 'en',
          title: 'Welcome',
          hash: 'hash-1',
          description: 'The home page',
          content: '# Welcome',
          render: '<h1>Welcome</h1>',
          toc: null,
          contentType: 'markdown',
          isPrivate: false,
          privateNS: null,
          isPublished: true,
          publishStartDate: null,
          publishEndDate: null,
          createdAt: '2023-01-01T00:00:00.000Z',
          updatedAt: '2023-09-01T00:00:00.000Z',
          extra: {},
          editorKey: 'markdown',
          tags: ['welcome', 'home'],
          // -> Resolved through ctx.userIdMap, standing in for a completed users-phase run.
          authorId: 555,
          creatorId: 555
        },
        {
          // -> Pre-exists in the destination tree (seeded below), so this one fails
          //    'existing-entry-collision' rather than being created.
          id: 2,
          path: 'blocked-page',
          localeCode: 'en',
          title: 'Blocked',
          hash: 'hash-2',
          description: null,
          content: '# Blocked',
          render: '<h1>Blocked</h1>',
          toc: null,
          contentType: 'markdown',
          isPrivate: false,
          privateNS: null,
          isPublished: true,
          publishStartDate: null,
          publishEndDate: null,
          createdAt: '2023-01-01T00:00:00.000Z',
          updatedAt: '2023-01-01T00:00:00.000Z',
          extra: {},
          editorKey: 'markdown',
          tags: [],
          authorId: null,
          creatorId: null
        }
      ]),
    pageHistory: () =>
      iter<SourceRecord>([
        {
          id: 101,
          pageId: 1,
          action: 'updated',
          path: 'welcome',
          localeCode: 'en',
          title: 'Welcome (first draft)',
          description: null,
          content: '# Welcome (first draft)',
          contentType: 'markdown',
          isPrivate: false,
          isPublished: true,
          publishStartDate: null,
          publishEndDate: null,
          editorKey: 'markdown',
          versionDate: '2023-03-01T00:00:00.000Z',
          createdAt: '2023-03-01T00:00:00.000Z',
          extra: {},
          tags: [],
          authorId: 555
        },
        {
          id: 102,
          pageId: 1,
          action: 'updated',
          path: 'welcome',
          localeCode: 'en',
          title: 'Welcome (revised)',
          description: null,
          content: '# Welcome (revised)',
          contentType: 'markdown',
          isPrivate: false,
          isPublished: true,
          publishStartDate: null,
          publishEndDate: null,
          editorKey: 'markdown',
          versionDate: '2023-06-01T00:00:00.000Z',
          createdAt: '2023-06-01T00:00:00.000Z',
          extra: {},
          tags: [],
          authorId: 555
        },
        {
          // -> Orphaned: pageId 999 names no current page (a deleted 2.x page). content-staging.ts
          //    keeps this (and the row below, same pageId) on ContentStagingContext.orphanedHistory
          //    rather than attaching either to any StagedPage — phases/content.ts backfills the whole
          //    group once `pages` has drained, via page-history-import.ts#backfillOrphanedPageHistory()'s
          //    batch form, sharing one freshly synthesized pageId across the group (see the "two rows,
          //    one synthesized pageId" assertion below).
          id: 201,
          pageId: 999,
          action: 'updated',
          path: 'long-gone',
          localeCode: 'en',
          title: 'Long Gone (v1)',
          description: null,
          content: '# Long gone, first version',
          contentType: 'markdown',
          isPrivate: false,
          isPublished: false,
          publishStartDate: null,
          publishEndDate: null,
          editorKey: 'markdown',
          versionDate: '2021-06-01T00:00:00.000Z',
          createdAt: '2021-06-01T00:00:00.000Z',
          extra: {},
          tags: [],
          authorId: null
        },
        {
          // -> Second row of the same orphaned group (same pageId 999) — proves the synthesized id is
          //    shared across the whole group, not minted once per row.
          id: 202,
          pageId: 999,
          action: 'deleted',
          path: 'long-gone',
          localeCode: 'en',
          title: 'Long Gone (v2, deleted)',
          description: null,
          content: null,
          contentType: 'markdown',
          isPrivate: false,
          isPublished: false,
          publishStartDate: null,
          publishEndDate: null,
          editorKey: 'markdown',
          versionDate: '2022-01-01T00:00:00.000Z',
          createdAt: '2022-01-01T00:00:00.000Z',
          extra: {},
          tags: [],
          authorId: null
        }
      ]),
    navigation: () =>
      iter<SourceRecord>([
        {
          key: 'site',
          config: [
            {
              id: 'nav-welcome',
              kind: 'link',
              label: 'Welcome',
              targetType: 'page',
              target: '/en/welcome'
            },
            { id: 'nav-home', kind: 'link', label: 'Home', targetType: 'home', target: '' },
            {
              // -> mapNavigationItem() carries an 'external' target through verbatim, unvalidated —
              //    this schemeless target would make the real setNavItems() throw
              //    CustomError('navigationInvalidTarget') without the sanitize-before-write fix, which
              //    would abort the whole phase (status: 'error', emptied report) after the "welcome"
              //    page above was already successfully created.
              id: 'nav-bad-external',
              kind: 'link',
              label: 'Bad External',
              targetType: 'external',
              target: 'example.com'
            }
          ]
        }
      ])
  })
}

describe(
  'contentPhase against a real destination database (Task 13)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures

    before(async () => {
      fixtures = await setupTestDb()
      // -> Pre-existing tree entry the "blocked-page" source page collides with.
      await seedTreeEntry(fixtures.db, {
        siteId: fixtures.siteId,
        path: 'blocked-page',
        locale: 'en',
        title: 'Already here'
      })
    })

    after(async () => {
      await teardownTestDb()
    })

    test('writes real pages/tree/pageHistory rows and the site navigation menu, correctly skipping a page that already exists at the destination', async () => {
      const ctx: MigrationContext = {
        db: fixtures.db,
        source: fakeSourceConnector(),
        siteId: fixtures.siteId,
        dryRun: false,
        // -> Task 14's fields, unused here — this phase only reads userIdMap/operatorActorId.
        localStrategyId: 'unused-local-strategy',
        systemGroupIds: { admin: 'unused-admin-group', guest: 'unused-guest-group' },
        operatorActorId: fixtures.userId,
        // -> Stands in for a completed users-phase run: source user 555 resolves to the fixture user.
        userIdMap: new Map([[555, fixtures.userId]])
      }

      const result = await contentPhase.run(ctx)

      assert.equal(result.status, 'ok')
      assert.deepEqual(result.counts, { pages: 2, navigation: 1 })
      assert.ok(result.report)
      assert.equal(result.report!.found, 3)
      assert.equal(result.report!.wouldCreate, 2) // -> "welcome" + navigation
      assert.equal(result.report!.wouldSkipExisting, 1) // -> "blocked-page"
      assert.deepEqual(result.report!.conflicts, [])

      // -> ctx.pageIdMap is a live reference, populated as a side effect of this run (Task 16 reads
      //    it for the assets/comments phase).
      assert.ok(ctx.pageIdMap)
      const newPageId = ctx.pageIdMap!.get(1)
      assert.ok(newPageId, 'the "welcome" page earned a real destination id')
      assert.equal(ctx.pageIdMap!.get(2), undefined, 'the blocked page was never created')

      // -> pages row, with the mapped author.
      const [page] = await fixtures.db
        .select()
        .from(pagesTable)
        .where(eq(pagesTable.id, newPageId!))
      assert.ok(page, 'the "welcome" page was written to pages')
      assert.equal(page!.title, 'Welcome')
      assert.equal(page!.path, 'welcome')
      assert.equal(page!.locale, 'en')
      assert.equal(page!.authorId, fixtures.userId)

      // -> tree row, correctly placed at the site root.
      const [treeEntry] = await fixtures.db
        .select()
        .from(treeTable)
        .where(
          and(
            eq(treeTable.siteId, fixtures.siteId),
            eq(treeTable.locale, 'en'),
            eq(treeTable.fileName, 'welcome')
          )
        )
      assert.ok(treeEntry, 'a matching tree entry exists')
      assert.equal(treeEntry!.folderPath, '')

      // -> pageHistory: 2 backfilled rows (Task 740) + 1 from createPage()'s own record() call.
      const historyRows = await fixtures.db
        .select()
        .from(pageHistoryTable)
        .where(eq(pageHistoryTable.pageId, newPageId!))
      assert.equal(historyRows.length, 3)
      const titles = historyRows.map((row) => row.title).sort()
      assert.deepEqual(titles, ['Welcome', 'Welcome (first draft)', 'Welcome (revised)'])

      // -> the "blocked-page" source page was never created, and left the pre-seeded tree entry
      //    untouched (no second page/tree row at that location).
      const blockedTreeEntries = await fixtures.db
        .select()
        .from(treeTable)
        .where(
          and(
            eq(treeTable.siteId, fixtures.siteId),
            eq(treeTable.locale, 'en'),
            eq(treeTable.fileName, 'blocked-page')
          )
        )
      assert.equal(blockedTreeEntries.length, 1)
      assert.equal(blockedTreeEntries[0]!.title, 'Already here')

      // -> the site's navigation menu was written, with the "page"-type item resolved onto the real
      //    new page id's path (locale prefix stripped), the "home"-type item resolved to '/', and the
      //    invalid schemeless "external" target blanked rather than aborting the whole phase (review
      //    fix — see the module doc comment's "Navigation targets are sanitized" section).
      const [navRow] = await fixtures.db
        .select()
        .from(navigationTable)
        .where(and(eq(navigationTable.siteId, fixtures.siteId), eq(navigationTable.locale, 'en')))
      assert.ok(navRow, 'the site-wide navigation row exists')
      assert.deepEqual(navRow!.items, [
        { id: 'nav-welcome', type: 'link', label: 'Welcome', target: '/welcome' },
        { id: 'nav-home', type: 'link', label: 'Home', target: '/' },
        { id: 'nav-bad-external', type: 'link', label: 'Bad External', target: '' }
      ])

      // -> orphaned pageHistory (review fix): both rows of the pageId-999 orphan group were written,
      //    sharing one freshly synthesized pageId that is real (a real pageHistory FK-shaped uuid) and
      //    distinct from the "welcome" page's own id.
      const orphanRows = await fixtures.db
        .select()
        .from(pageHistoryTable)
        .where(
          and(eq(pageHistoryTable.siteId, fixtures.siteId), eq(pageHistoryTable.path, 'long-gone'))
        )
      assert.equal(orphanRows.length, 2)
      const orphanTitles = orphanRows.map((row) => row.title).sort()
      assert.deepEqual(orphanTitles, ['Long Gone (v1)', 'Long Gone (v2, deleted)'])
      assert.equal(orphanRows[0]!.pageId, orphanRows[1]!.pageId)
      assert.notEqual(orphanRows[0]!.pageId, newPageId)
    })
  }
)
