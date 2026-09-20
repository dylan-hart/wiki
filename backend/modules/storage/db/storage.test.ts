import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import {
  sites as sitesTable,
  tree as treeTable,
  assets as assetsTable
} from '../../../db/schema.ts'
import { assetServing } from '../../../models/assetServing.ts'
import { assets } from '../../../models/assets.ts'
import { tree } from '../../../models/tree.ts'
import dbStorageModule, { purge } from './storage.ts'
import { DB_MODULE } from '../../../models/storage.ts'
import type { StorageTarget } from '../../../models/storage.ts'
import { makeStorageTarget } from '../../../test/builders.ts'
import { ensureTemporal } from '../../../test/temporal.ts'
import {
  hasTestDatabase,
  setupTestDb,
  teardownTestDb,
  type TestFixtures
} from '../../../test/db.ts'

/**
 * `purge()` runs against a real Postgres instance rather than a mocked `CARDINAL.db` chain because
 * what it has to get right is SQL correctness — that the update reaches only the assets a governing
 * direct-access target actually covers, and that only the `data`/`preview` columns move, never the
 * row's other metadata or its `tree` entry. A mock of the query builder would prove only that the
 * code calls what it calls.
 *
 * `CARDINAL.models.storage.getSiteTargets` is stubbed per test — the one piece of this that is
 * genuinely config, not SQL — so each test controls exactly which targets exist without needing real
 * storage module definitions loaded from disk.
 */
const skip = hasTestDatabase() ? false : 'requires DATABASE_URL (a Postgres instance)'

let fixtures: TestFixtures
let siteId: string
let otherSiteId: string
let userId: string

before(async () => {
  if (!hasTestDatabase()) {
    return
  }
  await ensureTemporal()

  fixtures = await setupTestDb()
  siteId = fixtures.siteId
  userId = fixtures.userId

  // -> `dropCachedContent()`'s `cachePath` getter reads both; a throwaway temp directory keeps this
  //    test away from a real instance's file cache.
  CARDINAL.ROOTPATH = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-db-storage-test-'))
  CARDINAL.config.dataPath = '.'

  const [other] = await CARDINAL.db
    .insert(sitesTable)
    .values({ hostname: `db-storage-purge-test-other-${Date.now()}.example.com`, config: {} })
    .returning({ id: sitesTable.id })
  otherSiteId = other.id
})

after(async () => {
  if (!hasTestDatabase()) {
    return
  }
  await teardownTestDb()
})

/**
 * The tree entry and the `assets` row share an id, mirroring `models/assets.ts`'s `upload()`, and
 * carry real `data`/`preview` bytes so a purge has something to null out.
 */
async function makeAsset(
  forSiteId: string,
  fileName: string,
  opts: { kind?: 'image' | 'document' | 'other'; fileSize?: number } = {}
): Promise<{ id: string; fileName: string }> {
  const kind = opts.kind ?? 'image'
  const fileSize = opts.fileSize ?? 4
  const entry = await tree.addAsset({
    fileName,
    title: fileName,
    locale: 'en',
    siteId: forSiteId,
    meta: { fileSize, fileExt: 'png', mimeType: 'image/png' }
  })
  await CARDINAL.db.insert(assetsTable).values({
    id: entry.id,
    siteId: forSiteId,
    authorId: userId,
    fileName,
    fileExt: 'png',
    kind,
    mimeType: 'image/png',
    fileSize,
    data: Buffer.from('data'),
    preview: Buffer.from('prev')
  })
  return { id: entry.id, fileName: entry.fileName }
}

/**
 * A fresh throwaway site per call, for a test asserting an aggregate `{ purged, skipped }` count: a
 * purge nulls bytes without deleting rows, so a count against the shared `siteId` fixture would
 * include whatever earlier tests left behind.
 */
async function withTestSite<T>(fn: (testSiteId: string) => Promise<T>): Promise<T> {
  const [site] = await CARDINAL.db
    .insert(sitesTable)
    .values({ hostname: `db-storage-purge-${randomUUID()}.example.com`, config: {} })
    .returning({ id: sitesTable.id })
  try {
    return await fn(site.id)
  } finally {
    // -> FK order: an asset row references the site (`assets_siteId_sites_id_fkey`), as does its
    //    tree entry, so the site goes last.
    await CARDINAL.db.delete(assetsTable).where(eq(assetsTable.siteId, site.id))
    await CARDINAL.db.delete(treeTable).where(eq(treeTable.siteId, site.id))
    await CARDINAL.db.delete(sitesTable).where(eq(sitesTable.id, site.id))
  }
}

/** Covers any asset whatever its kind or size, so `governingTargetFrom` picks it over `db`. */
function fullCoverageDirectAccessTarget(forSiteId: string): StorageTarget {
  return makeStorageTarget('s3', {
    siteId: forSiteId,
    isEnabled: true,
    assetDelivery: {
      isStreamingSupported: true,
      isDirectAccessSupported: true,
      streaming: false,
      directAccess: true
    },
    contentTypes: { activeTypes: ['images', 'documents', 'others', 'large'], largeThreshold: '5MB' }
  })
}

test('dbStorageModule declares only the purge handler', () => {
  assert.deepEqual(Object.keys(dbStorageModule), ['purge'])
})

test(
  'purge nulls out data and preview for every asset a covering direct-access target can still serve, leaving tree and metadata intact',
  { skip },
  async (t) => {
    t.mock.method(CARDINAL.models.storage, 'getSiteTargets', async () => [
      fullCoverageDirectAccessTarget(siteId)
    ])

    const purgedAsset = await makeAsset(siteId, `purge-me-${Date.now()}.png`)
    const untouchedAsset = await makeAsset(otherSiteId, `leave-me-${Date.now()}.png`)

    // -> A stale path resolution, as if `/_files/` had resolved this asset before the purge: proves
    //    a later request cannot re-serve a cached `hasPreview: true` for bytes that are now gone.
    assetServing.pathCache.set(`${siteId}:${purgedAsset.fileName}`, {
      asset: { hasPreview: true } as any,
      cachedAt: Date.now()
    })

    const target = { siteId } as StorageTarget
    const result = await purge(target)
    assert.deepEqual(result, { purged: 1, skipped: 0 })

    assert.equal(
      assetServing.pathCache.size,
      0,
      'expected purge to clear the cached path resolutions'
    )

    assert.equal(await assets.getContent(purgedAsset.id), null)
    const thumbnail = await assets.getThumbnail(purgedAsset.id)
    assert.equal(thumbnail, null)

    const metadata = await assets.getAsset(siteId, purgedAsset.id)
    assert.ok(metadata, 'expected the asset row to still exist')
    assert.equal(metadata!.fileName.startsWith('purge-me-'), true)
    assert.equal(metadata!.fileExt, 'png')
    assert.equal(metadata!.kind, 'image')
    assert.equal(metadata!.mimeType, 'image/png')
    assert.equal(metadata!.fileSize, 4)
    const [treeRow] = await CARDINAL.db
      .select()
      .from(treeTable)
      .where(eq(treeTable.id, purgedAsset.id))
    assert.ok(treeRow, 'expected the tree entry to still exist')
    assert.equal(treeRow.fileName, purgedAsset.fileName)
    assert.equal(treeRow.type, 'asset')

    assert.notEqual(await assets.getContent(untouchedAsset.id), null)
    const otherContent = await assets.getContent(untouchedAsset.id)
    assert.equal(otherContent!.data.toString(), 'data')
  }
)

test(
  'purge keeps an asset with no direct-access target covering it — the db is its only copy',
  { skip },
  async (t) => {
    await withTestSite(async (testSiteId) => {
      // -> Only the `db` target itself, the out-of-the-box case: with no direct-access target
      //    anywhere, the db holds the only copy, so nulling bytes here would be unrecoverable.
      t.mock.method(CARDINAL.models.storage, 'getSiteTargets', async () => [
        makeStorageTarget(DB_MODULE, { siteId: testSiteId, isEnabled: true })
      ])

      const keptAsset = await makeAsset(testSiteId, `keep-me-${Date.now()}.png`)

      const result = await purge({ siteId: testSiteId } as StorageTarget)
      assert.deepEqual(result, { purged: 0, skipped: 1 })

      const content = await assets.getContent(keptAsset.id)
      assert.ok(content, 'expected the asset bytes to survive a purge with no direct-access target')
      assert.equal(content!.data.toString(), 'data')
    })
  }
)

test(
  'purge is per-asset: an asset the direct-access target covers is purged, one it does not is kept',
  { skip },
  async (t) => {
    await withTestSite(async (testSiteId) => {
      // -> Scoped to images only, the way an admin would actually scope a direct-access target.
      t.mock.method(CARDINAL.models.storage, 'getSiteTargets', async () => [
        makeStorageTarget('s3', {
          siteId: testSiteId,
          isEnabled: true,
          assetDelivery: {
            isStreamingSupported: true,
            isDirectAccessSupported: true,
            streaming: false,
            directAccess: true
          },
          contentTypes: { activeTypes: ['images'], largeThreshold: '5MB' }
        })
      ])

      const coveredAsset = await makeAsset(testSiteId, `covered-${Date.now()}.png`, { kind: 'image' })
      const uncoveredAsset = await makeAsset(testSiteId, `uncovered-${Date.now()}.png`, {
        kind: 'other'
      })

      const result = await purge({ siteId: testSiteId } as StorageTarget)
      assert.deepEqual(result, { purged: 1, skipped: 1 })

      assert.equal(
        await assets.getContent(coveredAsset.id),
        null,
        'expected the direct-access-covered asset to be purged'
      )
      const uncoveredContent = await assets.getContent(uncoveredAsset.id)
      assert.ok(uncoveredContent, 'expected the uncovered asset to survive')
      assert.equal(uncoveredContent!.data.toString(), 'data')
    })
  }
)

test('purge is a no-op for a site with no assets', { skip }, async () => {
  const [emptySite] = await CARDINAL.db
    .insert(sitesTable)
    .values({ hostname: `db-storage-purge-empty-${Date.now()}.example.com`, config: {} })
    .returning({ id: sitesTable.id })
  try {
    const result = await purge({ siteId: emptySite.id } as StorageTarget)
    assert.deepEqual(result, { purged: 0, skipped: 0 })
  } finally {
    await CARDINAL.db.delete(sitesTable).where(eq(sitesTable.id, emptySite.id))
  }
})
