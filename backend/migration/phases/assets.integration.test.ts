import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { after, before, describe, test } from 'node:test'
import { and, eq } from 'drizzle-orm'
import { comments as commentsTable, tree as treeTable } from '../../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb } from '../../test/db.ts'
import { assetsPhase } from './assets.ts'
import { contentPhase } from './content.ts'
import type { TestFixtures } from '../../test/db.ts'
import type { SourceAssetFile, SourceConnector, SourceRecord } from '../connector.ts'
import type { MigrationContext } from '../context.ts'
import {
  iterate as iter,
  makeSourcePageRow,
  stubSourceConnector
} from '../../test/migrationFixtures.ts'

/** A minimal `SourceConnector` for seeding one real page through `contentPhase` — reusing Task 13's own
 * write path (`WIKI.models.pages.createPage()`) rather than hand-building a raw `pages`/`tree` row,
 * per this task's own "reuse Task 13's integration test's page import as a fixture" instruction. */
function fakeContentConnector(): SourceConnector {
  return stubSourceConnector({
    pages: () =>
      iter<SourceRecord>([
        makeSourcePageRow({
          description: null,
          updatedAt: '2023-01-01T00:00:00.000Z',
          // -> Resolved through `ctx.userIdMap`, standing in for a completed users-phase run.
          authorId: 555,
          creatorId: 555
        })
      ]),
    pageHistory: () => iter<SourceRecord>([]),
    navigation: () => iter<SourceRecord>([])
  })
}

/** A minimal `SourceConnector`: real `assets()`/`comments()` generators, everything else a
 * `NotYetImplementedError` stub since `assetsPhase` never reads them. */
function fakeSourceConnector(): SourceConnector {
  return stubSourceConnector({
    assets: () =>
      iter<SourceAssetFile>([
        {
          relativePath: 'docs/sub/diagram.png',
          filename: 'diagram.png',
          stream: Readable.from([Buffer.from('fake-image-bytes')]),
          authorId: 555,
          mimeType: 'image/png'
        }
      ]),
    comments: () =>
      iter<SourceRecord>([
        {
          id: 1,
          // -> Resolved through ctx.pageIdMap, standing in for a completed content-phase run.
          pageId: 1,
          authorId: 555,
          content: 'This page is great, thanks!'
        },
        {
          // -> pageId names no page ctx.pageIdMap has an entry for (never imported) — reported as
          //    'unknown-page' rather than crashing the phase.
          id: 2,
          pageId: 999,
          authorId: null,
          content: 'Orphaned comment, nowhere to attach',
          name: 'Guest Reader',
          email: 'guest@example.com'
        }
      ])
  })
}

describe(
  'assetsPhase against a real destination database (Task 16)',
  { skip: !hasTestDatabase() },
  () => {
    let fixtures: TestFixtures
    let pageId: string
    let seededPageIdMap: MigrationContext['pageIdMap']

    before(async () => {
      fixtures = await setupTestDb()
      // -> Seeds a real page through contentPhase's own write path (Task 13) — the same "reuse Task
      //    13's integration test's page import as a fixture" this task's own brief suggests, rather
      //    than hand-building a raw pages/tree row that has to independently track that model's real
      //    schema.
      const contentCtx: MigrationContext = {
        db: fixtures.db,
        source: fakeContentConnector(),
        siteId: fixtures.siteId,
        dryRun: false,
        localStrategyId: 'unused-local-strategy',
        systemGroupIds: { admin: 'unused-admin-group', guest: 'unused-guest-group' },
        operatorActorId: fixtures.userId,
        userIdMap: new Map([[555, fixtures.userId]])
      }
      const contentResult = await contentPhase.run(contentCtx)
      assert.equal(
        contentResult.status,
        'ok',
        'fixture setup: seeding the "welcome" page must succeed'
      )
      pageId = contentCtx.pageIdMap!.get(1)!
      assert.ok(pageId, 'fixture setup: the seeded page earned a real destination id')
      seededPageIdMap = contentCtx.pageIdMap
    })

    after(async () => {
      await teardownTestDb()
    })

    test('writes a real nested-folder asset (tree + assets rows) and a real comment on an already-imported page, correctly dropping one with no matching page', async () => {
      const ctx: MigrationContext = {
        db: fixtures.db,
        source: fakeSourceConnector(),
        siteId: fixtures.siteId,
        dryRun: false,
        localStrategyId: 'unused-local-strategy',
        systemGroupIds: { admin: 'unused-admin-group', guest: 'unused-guest-group' },
        operatorActorId: fixtures.userId,
        userIdMap: new Map([[555, fixtures.userId]]),
        // -> Reuses the live map the content-phase fixture setup above already populated, so this is
        //    the live reference a real migrate.ts run would hand from one phase to the next.
        pageIdMap: seededPageIdMap
      }

      const result = await assetsPhase.run(ctx)

      assert.equal(result.status, 'ok')
      assert.deepEqual(result.counts, { assets: 1, comments: 2 })
      assert.ok(result.report)
      assert.equal(result.report!.found, 3)
      assert.equal(result.report!.wouldCreate, 2) // -> the asset + the "welcome" comment
      assert.equal(result.report!.wouldSkipExisting, 0)
      assert.equal(result.report!.conflicts.length, 1)
      assert.match(result.report!.conflicts[0]!.detail, /pageId 999 was never imported/)

      // -> The asset landed at the correct nested tree placement, with an auto-created ancestor
      //    folder.
      const [assetTreeEntry] = await fixtures.db
        .select()
        .from(treeTable)
        .where(
          and(
            eq(treeTable.siteId, fixtures.siteId),
            eq(treeTable.locale, 'en'),
            eq(treeTable.fileName, 'diagram.png')
          )
        )
      assert.ok(assetTreeEntry, 'a matching tree entry exists for the uploaded asset')
      assert.equal(assetTreeEntry!.type, 'asset')
      assert.equal(assetTreeEntry!.folderPath, 'docs.sub')

      const [folderEntry] = await fixtures.db
        .select()
        .from(treeTable)
        .where(
          and(
            eq(treeTable.siteId, fixtures.siteId),
            eq(treeTable.locale, 'en'),
            eq(treeTable.type, 'folder'),
            eq(treeTable.fileName, 'sub')
          )
        )
      assert.ok(folderEntry, 'the ancestor folder was auto-created')

      // -> The comment on the already-imported page landed with the correctly resolved authorId.
      const commentRows = await fixtures.db
        .select()
        .from(commentsTable)
        .where(eq(commentsTable.pageId, pageId))
      assert.equal(commentRows.length, 1)
      assert.equal(commentRows[0]!.content, 'This page is great, thanks!')
      assert.equal(commentRows[0]!.authorId, fixtures.userId)
      assert.equal(commentRows[0]!.guestName, null)

      // -> The orphaned comment (unmapped pageId) was never written anywhere.
      const allComments = await fixtures.db.select().from(commentsTable)
      assert.equal(allComments.length, 1)
    })
  }
)
