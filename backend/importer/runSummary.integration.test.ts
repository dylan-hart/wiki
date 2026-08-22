import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { inArray } from 'drizzle-orm'
import { assets as assetsTable } from '../db/schema.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import type { SystemIds } from '../models/types.ts'
import type { SourceAssetRecord } from './assets.ts'
import { applyAssets, createImportRunSummary, validateAssets } from './runSummary.ts'

/**
 * Integration coverage for `applyAssets`, run against the shared DB-backed test fixture (see
 * `test/db.ts`), gated on `hasTestDatabase()` like every other DB-backed suite in this repo rather
 * than assuming a hand-started container is already listening on a hardcoded port.
 *
 * The point of this file is narrower than re-testing `importAssetsInBatches` itself (already covered
 * by `assetBatch.test.ts`): it confirms `applyAssets` folds a real write run into the exact same
 * `ImportRunSummary` shape — same field names, same counts — that `validateAssets`'s dry run produces
 * for the identical input, which is this task's whole point.
 */
describe('applyAssets', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let siteId: string
  let systemIds: SystemIds

  before(async () => {
    fixtures = await setupTestDb()
    siteId = fixtures.siteId
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
    const filename = overrides.filename ?? 'photo.png'
    return {
      sourceId: filename,
      filename,
      ext: '.png',
      mime: 'image/png',
      fileSize: 4,
      data: Buffer.from('data'),
      folderPath: '',
      authorId: null,
      siteId,
      createdAt: new Date('2020-01-01T00:00:00.000Z'),
      updatedAt: new Date('2020-01-01T00:00:00.000Z'),
      ...overrides
    }
  }

  test('writes for real and folds counts into the shared ImportRunSummary shape', async () => {
    const run = createImportRunSummary('apply')
    await applyAssets(
      [
        baseRecord({ filename: 'apply-1.png', fileSize: 10 }),
        baseRecord({ filename: 'apply-2.png', fileSize: 20 })
      ],
      systemIds,
      run,
      { makeThumbnail: async () => null }
    )

    assert.equal(run.assets.imported, 2)
    assert.equal(run.assets.failed, 0)
    assert.equal(run.assets.byteTotal, 30)

    const rows = await fixtures.db
      .select()
      .from(assetsTable)
      .where(inArray(assetsTable.fileName, ['apply-1.png', 'apply-2.png']))
    assert.equal(rows.length, 2)
  })

  test('records an author fallback as a warning item, still counted as imported', async () => {
    const run = createImportRunSummary('apply')
    const unresolvedAuthorId = randomUUID()
    await applyAssets(
      [baseRecord({ filename: 'apply-fallback.png', authorId: unresolvedAuthorId })],
      systemIds,
      run,
      { makeThumbnail: async () => null }
    )

    assert.equal(run.assets.imported, 1)
    assert.equal(run.items.length, 1)
    assert.equal(run.items[0].severity, 'warning')
    assert.equal(run.items[0].sourceId, 'apply-fallback.png')
  })

  test('produces the same category counts a dry run of the same valid records would', async () => {
    const records = () => [
      baseRecord({ filename: 'parity-1.png', fileSize: 7 }),
      baseRecord({ filename: 'parity-2.png', fileSize: 8 })
    ]

    const dryRun = createImportRunSummary('dry-run')
    await validateAssets(records(), dryRun)

    const applyRun = createImportRunSummary('apply')
    await applyAssets(records(), systemIds, applyRun, { makeThumbnail: async () => null })

    assert.equal(dryRun.assets.imported, applyRun.assets.imported)
    assert.equal(dryRun.assets.failed, applyRun.assets.failed)
    assert.equal(dryRun.assets.byteTotal, applyRun.assets.byteTotal)
  })
})
