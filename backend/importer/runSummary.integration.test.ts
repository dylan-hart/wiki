import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { assets as assetsTable, sites as sitesTable, users as usersTable } from '../db/schema.ts'
import { tree } from '../models/tree.ts'
import { users } from '../models/users.ts'
import type { SystemIds } from '../models/types.ts'
import type { SourceAssetRecord } from './assets.ts'
import { applyAssets, createImportRunSummary, validateAssets } from './runSummary.ts'

/**
 * Integration coverage for `applyAssets`, run against a throwaway Postgres — same setup as
 * `assets.test.ts`/`assetBatch.test.ts`, on the `wiki-test-db-758` container started by hand for this
 * task (never in this file: the test assumes it is already running, and does not manage its
 * lifecycle).
 *
 * The point of this file is narrower than re-testing `importAssetsInBatches` itself (already covered
 * by `assetBatch.test.ts`): it confirms `applyAssets` folds a real write run into the exact same
 * `ImportRunSummary` shape — same field names, same counts — that `validateAssets`'s dry run produces
 * for the identical input, which is this task's whole point.
 */
const PORT = 55758

let pool: Pool
let db: ReturnType<typeof drizzle>
let siteId: string
let systemIds: SystemIds

before(async () => {
  pool = new Pool({
    host: '127.0.0.1',
    port: PORT,
    user: 'postgres',
    password: 'postgres',
    database: 'postgres'
  })
  db = drizzle({ client: pool })

  await db.execute('CREATE EXTENSION IF NOT EXISTS ltree')
  await db.execute('CREATE EXTENSION IF NOT EXISTS pg_trgm')
  await migrate(db, {
    migrationsFolder: path.join(import.meta.dirname, '../db/migrations'),
    migrationsSchema: 'public',
    migrationsTable: 'migrations'
  })

  ;(global as any).WIKI = {
    db,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    models: { tree, users },
    sites: {}
  }

  const insertedSite = await db
    .insert(sitesTable)
    .values({ hostname: 'test.local', isEnabled: true, config: { locales: { primary: 'en' } } })
    .returning()
  siteId = insertedSite[0].id
  ;(global as any).WIKI.sites[siteId] = { config: { locales: { primary: 'en' } } }

  const insertedUsers = await db
    .insert(usersTable)
    .values([{ email: 'admin@example.com', name: 'Administrator' }])
    .returning()
  systemIds = {
    groupAdminId: randomUUID(),
    groupUserId: randomUUID(),
    groupGuestId: randomUUID(),
    siteId,
    authModuleId: randomUUID(),
    userAdminId: insertedUsers[0].id,
    userGuestId: randomUUID()
  }
})

after(async () => {
  await pool.end()
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

describe('applyAssets', () => {
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

    const rows = await db
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
