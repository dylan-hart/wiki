import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { assets as assetsTable, tree as treeTable } from '../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import type { SystemIds } from '../models/types.ts'
import {
  createAssetBatchImportSummary,
  importAssetsInBatches,
  type AssetBatchOptions
} from './assetBatch.ts'
import type { SourceAssetRecord } from './assets.ts'

/**
 * Integration coverage for `importAssetsInBatches`, run against the shared DB-backed test fixture
 * (see `test/db.ts`), gated on `hasTestDatabase()` like every other DB-backed suite in this repo
 * rather than assuming a hand-started container is already listening on a hardcoded port.
 */
describe('importAssetsInBatches', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let siteId: string
  let importedUserId: string
  let systemIds: SystemIds

  before(async () => {
    fixtures = await setupTestDb()
    siteId = fixtures.siteId
    importedUserId = fixtures.userId
    systemIds = {
      groupAdminId: randomUUID(),
      groupUserId: randomUUID(),
      groupGuestId: randomUUID(),
      siteId,
      authModuleId: randomUUID(),
      userAdminId: fixtures.userId,
      userGuestId: randomUUID(),
      classificationPublicId: randomUUID(),
      classificationInternalId: randomUUID(),
      classificationRestrictedId: randomUUID()
    }
  })

  after(async () => {
    await teardownTestDb()
  })

  let recordCounter = 0
  function record(overrides: Partial<SourceAssetRecord> = {}): SourceAssetRecord {
    recordCounter++
    const sourceId = overrides.sourceId ?? `src-${recordCounter}`
    return {
      sourceId,
      filename: `file-${recordCounter}.txt`,
      ext: '.txt',
      mime: 'text/plain',
      fileSize: 10,
      data: Buffer.from('0123456789'),
      folderPath: '',
      authorId: importedUserId,
      siteId,
      createdAt: new Date('2018-01-01T00:00:00.000Z'),
      updatedAt: new Date('2018-01-01T00:00:00.000Z'),
      ...overrides
    }
  }

  async function* toAsyncIterable<T>(items: T[]): AsyncIterable<T> {
    for (const item of items) {
      yield item
    }
  }

  const noThumbnail = async () => null

  test('splits records into multiple batches once maxBatchItems is hit', async () => {
    const records = [record(), record(), record(), record(), record()]
    const summary = createAssetBatchImportSummary()
    await importAssetsInBatches(toAsyncIterable(records), systemIds, summary, {
      maxBatchItems: 2,
      makeThumbnail: noThumbnail
    })

    assert.equal(summary.written, 5)
    assert.equal(summary.failedBatches.length, 0)
    for (const r of records) {
      const [row] = await fixtures.db
        .select()
        .from(assetsTable)
        .where(eq(assetsTable.fileName, r.filename.toLowerCase()))
      assert.ok(row, `${r.filename} was written`)
    }
  })

  test('splits records into multiple batches once maxBatchBytes is hit', async () => {
    const records = [record({ fileSize: 40 }), record({ fileSize: 40 }), record({ fileSize: 40 })]
    const summary = createAssetBatchImportSummary()
    await importAssetsInBatches(toAsyncIterable(records), systemIds, summary, {
      maxBatchItems: 100,
      maxBatchBytes: 50,
      makeThumbnail: noThumbnail
    })

    assert.equal(summary.written, 3)
    assert.equal(summary.failedBatches.length, 0)
  })

  test('skips a record over maxFileSizeBytes without reading its data, and does not fail its batch', async () => {
    let dataTouched = false
    // -> Built directly rather than through the `record()` helper: the helper merges its defaults via
    //    object spread, which would eagerly invoke a getter property and defeat the point of this test.
    const oversize: SourceAssetRecord = {
      sourceId: 'huge',
      filename: 'huge.bin',
      ext: '.bin',
      mime: 'application/octet-stream',
      fileSize: 1_000,
      get data(): Buffer {
        dataTouched = true
        return Buffer.alloc(1000)
      },
      folderPath: '',
      authorId: importedUserId,
      siteId,
      createdAt: new Date('2018-01-01T00:00:00.000Z'),
      updatedAt: new Date('2018-01-01T00:00:00.000Z')
    }
    const normal = record({ sourceId: 'normal', fileSize: 10 })
    const summary = createAssetBatchImportSummary()

    await importAssetsInBatches(toAsyncIterable([oversize, normal]), systemIds, summary, {
      maxFileSizeBytes: 100,
      makeThumbnail: noThumbnail
    })

    assert.equal(dataTouched, false, "the oversize record's bytes were never read")
    assert.equal(summary.skippedOversize.length, 1)
    assert.equal(summary.skippedOversize[0].sourceId, 'huge')
    assert.match(summary.skippedOversize[0].reason, /maxFileSizeBytes/)
    assert.equal(summary.written, 1)
    assert.equal(summary.failedBatches.length, 0)
  })

  test("a failing item rolls back its whole batch — none of that batch's items persist", async () => {
    const good1 = record({ sourceId: 'batch-good-1' })
    const good2 = record({ sourceId: 'batch-good-2' })
    // -> A syntactically invalid authorId makes `WIKI.models.users.getById` throw a genuine
    //    "invalid input syntax for type uuid" from Postgres itself — a reliable, DB-level failure
    //    that has nothing to do with this writer's own recoverable fallback path (an authorId that is
    //    merely *unresolved*, unlike this one, is substituted with `userAdminId` rather than thrown).
    const bad = record({ sourceId: 'batch-bad', authorId: 'not-a-valid-uuid' })

    const summary = createAssetBatchImportSummary()
    await importAssetsInBatches(toAsyncIterable([good1, good2, bad]), systemIds, summary, {
      maxBatchItems: 100,
      makeThumbnail: noThumbnail
    })

    assert.equal(summary.failedBatches.length, 1)
    assert.deepEqual(summary.failedBatches[0].sourceIds, [
      'batch-good-1',
      'batch-good-2',
      'batch-bad'
    ])

    for (const r of [good1, good2, bad]) {
      const [row] = await fixtures.db
        .select()
        .from(assetsTable)
        .where(eq(assetsTable.fileName, r.filename.toLowerCase()))
      assert.equal(row, undefined, `${r.filename} must not have survived the rolled-back batch`)
    }
    const [treeRow] = await fixtures.db
      .select()
      .from(treeTable)
      .where(eq(treeTable.fileName, good1.filename.toLowerCase()))
    assert.equal(
      treeRow,
      undefined,
      'the tree row for a rolled-back batch item must not survive either'
    )
  })

  test('retrying after a batch failure does not duplicate an already-committed neighbor batch', async () => {
    const firstBatch = [
      record({ sourceId: 'retry-committed-1' }),
      record({ sourceId: 'retry-committed-2' })
    ]
    const failingBatch = [record({ sourceId: 'retry-committed-3', authorId: 'not-a-valid-uuid' })]
    const allRecords = () => [...firstBatch, ...failingBatch].map((r) => ({ ...r }))

    const firstRun = createAssetBatchImportSummary()
    await importAssetsInBatches(toAsyncIterable(allRecords()), systemIds, firstRun, {
      maxBatchItems: 2,
      makeThumbnail: noThumbnail
    })
    assert.equal(firstRun.written, 2)
    assert.equal(firstRun.failedBatches.length, 1)

    // -> Re-run the entire stream from the start, as an operator would after fixing whatever made the
    //    third record fail. The first batch's two records must be recognized as already-imported, not
    //    duplicated — even though nothing about the runner remembers the previous run happened.
    const secondRun = createAssetBatchImportSummary()
    await importAssetsInBatches(toAsyncIterable(allRecords()), systemIds, secondRun, {
      maxBatchItems: 2,
      makeThumbnail: noThumbnail
    })
    assert.equal(
      secondRun.alreadyImported,
      2,
      'the two already-committed records were recognized, not rewritten'
    )
    assert.equal(secondRun.written, 0)
    assert.equal(secondRun.failedBatches.length, 1, 'the still-bad record fails again on retry')

    for (const r of firstBatch) {
      const rows = await fixtures.db
        .select()
        .from(assetsTable)
        .where(eq(assetsTable.fileName, r.filename.toLowerCase()))
      assert.equal(rows.length, 1, `${r.filename} exists exactly once, not duplicated`)
    }
  })

  test('an AssetBatchOptions.db override runs batches against that db instead of the ambient WIKI.db', async () => {
    const records = [record()]
    const summary = createAssetBatchImportSummary()
    // -> Passing the very same drizzle instance the tests already use as an explicit override, rather
    //    than relying on the ambient WIKI.db fallback, proves the option is actually read.
    await importAssetsInBatches(toAsyncIterable(records), systemIds, summary, {
      db: fixtures.db as AssetBatchOptions['db'],
      makeThumbnail: noThumbnail
    })
    assert.equal(summary.written, 1)
  })
})
