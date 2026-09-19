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

/** A minimal `SourceConnector` for seeding one real page through `contentPhase`, so the fixture goes
 * through the real `createPage()` write path rather than a hand-built `pages`/`tree` row that would
 * have to track that model's schema on its own. */
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
        // -> The live map the content-phase setup above populated, as a real run would hand it from
        //    one phase to the next.
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

    test('carries real 2.x timestamps through and resolves a forward-referencing reply thread (OpenProject #3204)', async () => {
      const threadedConnector = stubSourceConnector({
        comments: () =>
          iter<SourceRecord>([
            {
              // -> Names old id 21, which is imported later in this same stream: the
              //    forward-reference case the second pass exists for.
              id: 20,
              pageId: 1,
              authorId: 555,
              content: 'A reply to a comment further down the stream',
              replyTo: 21,
              createdAt: '2020-02-02T00:00:00.000Z',
              updatedAt: '2020-02-02T00:00:00.000Z'
            },
            {
              id: 21,
              pageId: 1,
              authorId: 555,
              content: 'The original comment, imported second',
              replyTo: 0, // -> 2.x's own top-level sentinel, not null
              createdAt: '2020-01-01T00:00:00.000Z',
              updatedAt: '2020-01-01T00:00:00.000Z'
            }
          ]),
        assets: () => iter([])
      })
      const ctx: MigrationContext = {
        db: fixtures.db,
        source: threadedConnector,
        siteId: fixtures.siteId,
        dryRun: false,
        localStrategyId: 'unused-local-strategy',
        systemGroupIds: { admin: 'unused-admin-group', guest: 'unused-guest-group' },
        operatorActorId: fixtures.userId,
        userIdMap: new Map([[555, fixtures.userId]]),
        pageIdMap: seededPageIdMap
      }

      const result = await assetsPhase.run(ctx)

      assert.equal(result.status, 'ok')
      assert.deepEqual(result.counts, { assets: 0, comments: 2 })

      const threadRows = await fixtures.db
        .select()
        .from(commentsTable)
        .where(eq(commentsTable.pageId, pageId))
      const reply = threadRows.find((row) => row.content.startsWith('A reply'))!
      const original = threadRows.find((row) => row.content.startsWith('The original'))!

      assert.ok(reply, 'the reply comment was written')
      assert.ok(original, 'the original comment was written')
      assert.equal(reply.replyTo, original.id, 'the forward reference resolved to the real parent')
      assert.equal(original.replyTo, null, 'the 0-sentinel top-level comment stayed top-level')
      assert.equal(reply.createdAt.toISOString(), '2020-02-02T00:00:00.000Z')
      assert.equal(original.createdAt.toISOString(), '2020-01-01T00:00:00.000Z')
    })
  }
)
