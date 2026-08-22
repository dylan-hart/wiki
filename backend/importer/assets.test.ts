import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { after, before, describe, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { assets as assetsTable, tree as treeTable, users as usersTable } from '../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import type { SystemIds } from '../models/types.ts'
import { createAssetImportSummary, writeImportedAsset, type SourceAssetRecord } from './assets.ts'

/**
 * Integration coverage for `writeImportedAsset`, run against the shared DB-backed test fixture (see
 * `test/db.ts`) — the same real-schema-and-migrations approach `core/db.ts`'s `syncSchemas` uses at
 * boot, gated on `hasTestDatabase()` like every other DB-backed suite in this repo rather than
 * assuming a hand-started container is already listening on a hardcoded port.
 */
describe('writeImportedAsset', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let siteId: string
  let importedUserId: string
  let systemIds: SystemIds

  before(async () => {
    fixtures = await setupTestDb()
    siteId = fixtures.siteId

    // -> `setupTestDb()`'s own fixture user stands in for the admin account; a second user is
    //    inserted directly as the imported content's distinct author.
    const [insertedUser] = await fixtures.db
      .insert(usersTable)
      .values({ email: 'imported-author@example.com', name: 'Imported Author' })
      .returning()
    importedUserId = insertedUser!.id

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

  function baseRecord(overrides: Partial<SourceAssetRecord> = {}): SourceAssetRecord {
    const filename = overrides.filename ?? 'Photo.PNG'
    return {
      // -> Every test in this file uses a distinct `filename`, so defaulting `sourceId` to it keeps
      //    each record's deterministic id distinct too, without every call site having to say so.
      sourceId: filename,
      filename,
      ext: '.png',
      mime: 'image/png',
      fileSize: 4,
      data: Buffer.from('data'),
      folderPath: '',
      authorId: importedUserId,
      siteId,
      createdAt: new Date('2019-03-14T08:00:00.000Z'),
      updatedAt: new Date('2020-11-02T12:30:00.000Z'),
      ...overrides
    }
  }

  const noThumbnail = async () => null

  test('writes a paired assets + tree row sharing one UUID', async () => {
    const summary = createAssetImportSummary()
    const asset = await writeImportedAsset(baseRecord(), systemIds, summary, {
      makeThumbnail: noThumbnail
    })

    const [assetRow] = await fixtures.db
      .select()
      .from(assetsTable)
      .where(eq(assetsTable.id, asset.id))
    const [treeRow] = await fixtures.db.select().from(treeTable).where(eq(treeTable.id, asset.id))

    assert.ok(assetRow, 'assets row was written')
    assert.ok(treeRow, 'tree row was written')
    assert.equal(treeRow.id, assetRow.id)
    assert.equal(treeRow.type, 'asset')
    assert.equal(treeRow.fileName, 'photo.png')
  })

  test('preserves the source createdAt/updatedAt instead of defaulting to now()', async () => {
    const summary = createAssetImportSummary()
    const record = baseRecord({ filename: 'timestamped.png' })
    const asset = await writeImportedAsset(record, systemIds, summary, {
      makeThumbnail: noThumbnail
    })

    const [assetRow] = await fixtures.db
      .select()
      .from(assetsTable)
      .where(eq(assetsTable.id, asset.id))
    const [treeRow] = await fixtures.db.select().from(treeTable).where(eq(treeTable.id, asset.id))

    assert.equal(assetRow.createdAt.toISOString(), record.createdAt.toISOString())
    assert.equal(assetRow.updatedAt.toISOString(), record.updatedAt.toISOString())
    assert.equal(treeRow.createdAt.toISOString(), record.createdAt.toISOString())
    assert.equal(treeRow.updatedAt.toISOString(), record.updatedAt.toISOString())
  })

  test('recomputes kind/mimeType instead of trusting the source mime column', async () => {
    const summary = createAssetImportSummary()
    // -> Source claims a PDF, but the file name's own extension is `.png` — the recomputed value
    //    must win, exactly like a live upload resolving a mismatched Content-Type.
    const record = baseRecord({
      filename: 'mislabeled.png',
      ext: '.png',
      mime: 'application/pdf'
    })
    const asset = await writeImportedAsset(record, systemIds, summary, {
      makeThumbnail: noThumbnail
    })

    assert.equal(asset.mimeType, 'image/png')
    assert.equal(asset.kind, 'image')
  })

  test('regenerates a preview for an image-kind asset via makeImageThumbnail', async () => {
    const summary = createAssetImportSummary()
    const thumbnail = Buffer.from('thumb-bytes')
    const record = baseRecord({ filename: 'with-preview.png' })
    const asset = await writeImportedAsset(record, systemIds, summary, {
      makeThumbnail: async () => thumbnail
    })

    assert.equal(asset.hasPreview, true)
    const [assetRow] = await fixtures.db
      .select()
      .from(assetsTable)
      .where(eq(assetsTable.id, asset.id))
    assert.deepEqual(assetRow.preview, thumbnail)
  })

  test('does not generate a preview for a non-image asset', async () => {
    const summary = createAssetImportSummary()
    let thumbnailCalled = false
    const record = baseRecord({
      filename: 'document.pdf',
      ext: '.pdf',
      mime: 'application/pdf'
    })
    const asset = await writeImportedAsset(record, systemIds, summary, {
      makeThumbnail: async () => {
        thumbnailCalled = true
        return Buffer.from('x')
      }
    })

    assert.equal(thumbnailCalled, false)
    assert.equal(asset.hasPreview, false)
    assert.equal(asset.kind, 'document')
  })

  test('buffers a byte-stream handle rather than requiring a Buffer up front', async () => {
    const summary = createAssetImportSummary()
    const record = baseRecord({
      filename: 'streamed.png',
      data: Readable.from([Buffer.from('st'), Buffer.from('ream')])
    })
    const asset = await writeImportedAsset(record, systemIds, summary, {
      makeThumbnail: noThumbnail
    })

    const [assetRow] = await fixtures.db
      .select()
      .from(assetsTable)
      .where(eq(assetsTable.id, asset.id))
    assert.deepEqual(assetRow.data, Buffer.from('stream'))
  })

  test('falls back to userAdminId and records the substitution when authorId does not resolve', async () => {
    const summary = createAssetImportSummary()
    const unresolvedId = randomUUID()
    const record = baseRecord({ filename: 'unresolved-author.png', authorId: unresolvedId })
    const asset = await writeImportedAsset(record, systemIds, summary, {
      makeThumbnail: noThumbnail
    })

    const [assetRow] = await fixtures.db
      .select()
      .from(assetsTable)
      .where(eq(assetsTable.id, asset.id))
    assert.equal(assetRow.authorId, systemIds.userAdminId)
    assert.equal(summary.authorFallbacks.length, 1)
    assert.equal(summary.authorFallbacks[0].sourceAuthorId, unresolvedId)
    assert.equal(summary.authorFallbacks[0].assetId, asset.id)
  })

  test('falls back to userAdminId when authorId is null, without failing the item', async () => {
    const summary = createAssetImportSummary()
    const record = baseRecord({ filename: 'no-author.png', authorId: null })
    const asset = await writeImportedAsset(record, systemIds, summary, {
      makeThumbnail: noThumbnail
    })

    const [assetRow] = await fixtures.db
      .select()
      .from(assetsTable)
      .where(eq(assetsTable.id, asset.id))
    assert.equal(assetRow.authorId, systemIds.userAdminId)
    assert.equal(summary.authorFallbacks.length, 1)
    assert.equal(summary.authorFallbacks[0].sourceAuthorId, null)
  })

  test('keeps a resolvable authorId as-is, with no fallback recorded', async () => {
    const summary = createAssetImportSummary()
    const record = baseRecord({ filename: 'resolvable-author.png' })
    const asset = await writeImportedAsset(record, systemIds, summary, {
      makeThumbnail: noThumbnail
    })

    const [assetRow] = await fixtures.db
      .select()
      .from(assetsTable)
      .where(eq(assetsTable.id, asset.id))
    assert.equal(assetRow.authorId, importedUserId)
    assert.equal(summary.authorFallbacks.length, 0)
  })

  test('creates the resolved folder path and places the tree row under it', async () => {
    const summary = createAssetImportSummary()
    const record = baseRecord({ filename: 'nested.png', folderPath: 'imported/gallery' })
    const asset = await writeImportedAsset(record, systemIds, summary, {
      makeThumbnail: noThumbnail
    })

    assert.equal(asset.folderPath, 'imported/gallery')
    const [treeRow] = await fixtures.db.select().from(treeTable).where(eq(treeTable.id, asset.id))
    assert.equal(treeRow.folderPath, 'imported.gallery')
  })

  test('increments summary.written on every successful write', async () => {
    const summary = createAssetImportSummary()
    await writeImportedAsset(baseRecord({ filename: 'count-1.png' }), systemIds, summary, {
      makeThumbnail: noThumbnail
    })
    await writeImportedAsset(baseRecord({ filename: 'count-2.png' }), systemIds, summary, {
      makeThumbnail: noThumbnail
    })
    assert.equal(summary.written, 2)
  })
})
