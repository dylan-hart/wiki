import { test, before, after } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { eq } from 'drizzle-orm'
import {
  sites as sitesTable,
  tree as treeTable,
  assets as assetsTable
} from '../../../db/schema.ts'
import { assetServing } from '../../../models/assetServing.ts'
import { assets } from '../../../models/assets.ts'
import { tree } from '../../../models/tree.ts'
import dbStorageModule, { purge, verifyCopy } from './storage.ts'
import { DB_MODULE } from '../../../models/storage.ts'
import type { StorageTarget } from '../../../models/storage.ts'
import { makeStorageTarget } from '../../../test/builders.ts'
import { ensureTemporal } from '../../../test/temporal.ts'
import { installTestWiki } from '../../../test/mocks.ts'
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

function copyOf(bytes: string | Buffer): Record<string, any> {
  const buf = Buffer.from(bytes)
  return {
    headAsset: async () => ({ size: buf.length }),
    readAsset: async () => ({
      body: Readable.from([buf.subarray(0, 2), buf.subarray(2)]),
      size: buf.length
    })
  }
}

function stubModule(t: TestContext, handlers: Record<string, any>) {
  t.mock.method(CARDINAL.models.storage, 'ensureModule', async () => handlers)
}

function readThroughOnlyTarget(forSiteId: string, overrides: Record<string, any> = {}) {
  return makeStorageTarget('s3', {
    siteId: forSiteId,
    isEnabled: true,
    assetDelivery: {
      isStreamingSupported: true,
      isDirectAccessSupported: true,
      isReadThroughSupported: true,
      streaming: false,
      directAccess: false,
      readThrough: true
    },
    ...overrides
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
    stubModule(t, copyOf('data'))

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
    assert.deepEqual(result, { purged: 1, skipped: 0, unverified: 0 })

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
      assert.deepEqual(result, { purged: 0, skipped: 1, unverified: 0 })

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
      stubModule(t, copyOf('data'))

      const coveredAsset = await makeAsset(testSiteId, `covered-${Date.now()}.png`, {
        kind: 'image'
      })
      const uncoveredAsset = await makeAsset(testSiteId, `uncovered-${Date.now()}.png`, {
        kind: 'other'
      })

      const result = await purge({ siteId: testSiteId } as StorageTarget)
      assert.deepEqual(result, { purged: 1, skipped: 1, unverified: 0 })

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
    assert.deepEqual(result, { purged: 0, skipped: 0, unverified: 0 })
  } finally {
    await CARDINAL.db.delete(sitesTable).where(eq(sitesTable.id, emptySite.id))
  }
})

async function purgeWithCopy(
  t: TestContext,
  handlers: Record<string, any>,
  opts: {
    targets?: (siteId: string) => StorageTarget[]
    fileSize?: number
    nullBytes?: boolean
  } = {}
) {
  return withTestSite(async (testSiteId) => {
    const targets = (opts.targets ?? ((id: string) => [fullCoverageDirectAccessTarget(id)]))(
      testSiteId
    )
    t.mock.method(CARDINAL.models.storage, 'getSiteTargets', async () => targets)
    stubModule(t, handlers)
    const asset = await makeAsset(testSiteId, `verify-${randomUUID()}.png`, {
      fileSize: opts.fileSize
    })
    if (opts.nullBytes) {
      await CARDINAL.db.update(assetsTable).set({ data: null }).where(eq(assetsTable.id, asset.id))
    }
    const result = await purge({ siteId: testSiteId } as StorageTarget)
    const [row] = await CARDINAL.db
      .select({ data: assetsTable.data })
      .from(assetsTable)
      .where(eq(assetsTable.id, asset.id))
    return { result, bytes: row?.data?.toString() ?? null }
  })
}

test('purge nulls a verified asset and reports it as purged', { skip }, async (t) => {
  const { result, bytes } = await purgeWithCopy(t, copyOf('data'))
  assert.deepEqual(result, { purged: 1, skipped: 0, unverified: 0 })
  assert.equal(bytes, null)
})

test('purge keeps bytes and counts unverified when the copy is missing', { skip }, async (t) => {
  const { result, bytes } = await purgeWithCopy(t, {
    headAsset: async () => null,
    readAsset: async () => null
  })
  assert.deepEqual(result, { purged: 0, skipped: 0, unverified: 1 })
  assert.equal(bytes, 'data')
})

test('purge keeps bytes when the copy has the wrong size', { skip }, async (t) => {
  const { result, bytes } = await purgeWithCopy(t, copyOf('data-and-more'))
  assert.deepEqual(result, { purged: 0, skipped: 0, unverified: 1 })
  assert.equal(bytes, 'data')
})

test(
  'purge keeps bytes when the copy has the right size but the wrong hash',
  { skip },
  async (t) => {
    const { result, bytes } = await purgeWithCopy(t, copyOf('dat4'))
    assert.deepEqual(result, { purged: 0, skipped: 0, unverified: 1 })
    assert.equal(bytes, 'data')
  }
)

test('purge keeps bytes when reading the copy throws', { skip }, async (t) => {
  const { result, bytes } = await purgeWithCopy(t, {
    headAsset: async () => ({ size: 4 }),
    readAsset: async () => {
      throw new Error('Failed to read "k": boom')
    }
  })
  assert.deepEqual(result, { purged: 0, skipped: 0, unverified: 1 })
  assert.equal(bytes, 'data')
})

test('purge keeps bytes when the module cannot read objects at all', { skip }, async (t) => {
  const boom = async () => {
    throw new Error('reading objects is not supported by Azure')
  }
  const { result, bytes } = await purgeWithCopy(t, { headAsset: boom, readAsset: boom })
  assert.deepEqual(result, { purged: 0, skipped: 0, unverified: 1 })
  assert.equal(bytes, 'data')
})

test('purge keeps bytes when assets.fileSize disagrees with the db bytes', { skip }, async (t) => {
  const { result, bytes } = await purgeWithCopy(t, copyOf('data'), { fileSize: 9 })
  assert.deepEqual(result, { purged: 0, skipped: 0, unverified: 1 })
  assert.equal(bytes, 'data')
})

test(
  'purge counts an enabled read-through target that covers the asset, with no direct access',
  { skip },
  async (t) => {
    const { result, bytes } = await purgeWithCopy(t, copyOf('data'), {
      targets: (id) => [readThroughOnlyTarget(id)]
    })
    assert.deepEqual(result, { purged: 1, skipped: 0, unverified: 0 })
    assert.equal(bytes, null)
  }
)

test(
  'purge skips an asset when the only blob target is not nominated for read-through',
  { skip },
  async (t) => {
    const { result, bytes } = await purgeWithCopy(t, copyOf('data'), {
      targets: (id) => [
        readThroughOnlyTarget(id, {
          assetDelivery: {
            isStreamingSupported: true,
            isDirectAccessSupported: true,
            isReadThroughSupported: true,
            streaming: false,
            directAccess: false,
            readThrough: false
          }
        })
      ]
    })
    assert.deepEqual(result, { purged: 0, skipped: 1, unverified: 0 })
    assert.equal(bytes, 'data')
  }
)

test(
  'purge tries the next covering target when the first copy fails verification',
  { skip },
  async (t) => {
    const good = copyOf('data')
    const { result, bytes } = await withTestSite(async (testSiteId) => {
      t.mock.method(CARDINAL.models.storage, 'getSiteTargets', async () => [
        fullCoverageDirectAccessTarget(testSiteId),
        readThroughOnlyTarget(testSiteId, { module: 'gcs' })
      ])
      t.mock.method(CARDINAL.models.storage, 'ensureModule', async (key: string): Promise<any> =>
        key === 'gcs' ? good : { headAsset: async () => null, readAsset: async () => null }
      )
      const asset = await makeAsset(testSiteId, `second-${randomUUID()}.png`)
      const outcome = await purge({ siteId: testSiteId } as StorageTarget)
      const content = await assets.getContent(asset.id)
      return { result: outcome, bytes: content }
    })
    assert.deepEqual(result, { purged: 1, skipped: 0, unverified: 0 })
    assert.equal(bytes, null)
  }
)

test(
  'purge does not null bytes replaced by an upload while the copy was being verified',
  { skip },
  async (t) => {
    const { result, bytes } = await purgeWithCopy(t, {
      headAsset: async () => ({ size: 4 }),
      readAsset: async (asset: { id: string }): Promise<{ body: Readable; size: number }> => {
        await CARDINAL.db
          .update(assetsTable)
          .set({ data: Buffer.from('new!') })
          .where(eq(assetsTable.id, asset.id))
        return { body: Readable.from([Buffer.from('data')]), size: 4 }
      }
    })
    assert.deepEqual(result, { purged: 0, skipped: 0, unverified: 1 })
    assert.equal(bytes, 'new!')
  }
)

test('purge skips an asset whose bytes are already gone', { skip }, async (t) => {
  const { result } = await purgeWithCopy(t, copyOf('data'), { nullBytes: true })
  assert.deepEqual(result, { purged: 0, skipped: 1, unverified: 0 })
})

const unitAsset = {
  id: 'a1',
  kind: 'image' as const,
  folderPath: '',
  fileName: 'a.png',
  fileSize: 4
}

async function unitVerify(handlers: Record<string, any>) {
  const wiki = installTestWiki({ models: { storage: { ensureModule: async () => handlers } } })
  try {
    const bytes = Buffer.from('data')
    const digest = createHash('sha256').update(bytes).digest()
    return await verifyCopy(makeStorageTarget('s3'), unitAsset, bytes, digest)
  } finally {
    wiki.restore()
  }
}

test('verifyCopy accepts an identical multi-chunk copy', async () => {
  assert.equal(await unitVerify(copyOf('data')), true)
})

test('verifyCopy rejects a missing, wrong-size, wrong-hash, truncated or unsupported copy', async () => {
  assert.equal(
    await unitVerify({ headAsset: async () => null, readAsset: async () => null }),
    false
  )
  assert.equal(await unitVerify(copyOf('data!')), false)
  assert.equal(await unitVerify(copyOf('dat4')), false)
  assert.equal(
    await unitVerify({
      headAsset: async () => ({ size: 4 }),
      readAsset: async () => ({ body: Readable.from([Buffer.from('da')]), size: 4 })
    }),
    false
  )
  assert.equal(await unitVerify({}), false)
})

test('verifyCopy treats a throwing module as unverified rather than failing the purge', async () => {
  const boom = async () => {
    throw new Error('Failed to inspect "k": reading objects is not supported by S3')
  }
  assert.equal(await unitVerify({ headAsset: boom, readAsset: boom }), false)
})

test('verifyCopy stops reading and closes a body that runs past the expected size', async () => {
  const body = Readable.from([Buffer.from('data'), Buffer.from('extra')])
  const closed = new Promise((resolve) => body.on('close', resolve))
  const ok = await unitVerify({
    headAsset: async () => ({ size: 4 }),
    readAsset: async () => ({ body, size: 4 })
  })
  assert.equal(ok, false)
  await closed
})
