import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { relations } from '../../../db/relations.ts'
import {
  assets as assetsTable,
  sites as sitesTable,
  tree as treeTable,
  users as usersTable
} from '../../../db/schema.ts'
import { assetServing } from '../../../models/assetServing.ts'
import { assets } from '../../../models/assets.ts'
import { tree } from '../../../models/tree.ts'
import dbStorageModule, { purge } from './storage.ts'
import type { StorageTarget } from '../../../models/storage.ts'
import { ensureTemporal } from '../../../test/temporal.ts'
import { installTestWiki } from '../../../test/mocks.ts'

/**
 * Exercises `purge()` against a real Postgres instance rather than a mocked `WIKI.db` chain, because
 * what it has to get right is SQL correctness — that the `WHERE siteId = ...` scopes to the right site
 * and only the `data`/`preview` columns move, never the row's other metadata or its `tree` entry. A
 * mock of the query builder would only prove that the code calls what it calls, not that the SQL it
 * builds does the right thing.
 *
 * Skipped unless `DATABASE_URL` points at a real database with this repo's migrations applied — see
 * `models/contentSync.test.ts` for the same convention. Nothing here mutates outside the sites created
 * and torn down by this file.
 */
const DATABASE_URL = process.env.DATABASE_URL
const skip = DATABASE_URL
  ? false
  : 'requires DATABASE_URL (a Postgres instance with migrations applied)'

let pool: Pool
let siteId: string
let otherSiteId: string
let userId: string

before(async () => {
  if (!DATABASE_URL) {
    return
  }
  await ensureTemporal()

  pool = new Pool({ connectionString: DATABASE_URL })
  const db = drizzle({ client: pool, relations })
  installTestWiki({
    db,
    // -> `dropCachedContent()`'s `cachePath` getter reads both of these; pointed at a throwaway temp
    //    directory so this test never touches a real instance's file cache.
    ROOTPATH: await import('node:fs/promises').then((fs) =>
      fs.mkdtemp(path.join(os.tmpdir(), 'wiki-db-storage-test-'))
    ),
    config: { dataPath: '.' },
    models: { assets, assetServing }
  })

  const [site] = await WIKI.db
    .insert(sitesTable)
    .values({ hostname: `db-storage-purge-test-${Date.now()}.example.com`, config: {} })
    .returning({ id: sitesTable.id })
  siteId = site.id

  const [other] = await WIKI.db
    .insert(sitesTable)
    .values({ hostname: `db-storage-purge-test-other-${Date.now()}.example.com`, config: {} })
    .returning({ id: sitesTable.id })
  otherSiteId = other.id

  const [user] = await WIKI.db
    .insert(usersTable)
    .values({ email: `db-storage-purge-test-${Date.now()}@example.com`, name: 'Purge Test' })
    .returning({ id: usersTable.id })
  userId = user.id
})

after(async () => {
  if (!DATABASE_URL) {
    return
  }
  await WIKI.db.delete(treeTable).where(eq(treeTable.siteId, siteId))
  await WIKI.db.delete(treeTable).where(eq(treeTable.siteId, otherSiteId))
  await WIKI.db.delete(assetsTable).where(eq(assetsTable.siteId, siteId))
  await WIKI.db.delete(assetsTable).where(eq(assetsTable.siteId, otherSiteId))
  await WIKI.db.delete(sitesTable).where(eq(sitesTable.id, siteId))
  await WIKI.db.delete(sitesTable).where(eq(sitesTable.id, otherSiteId))
  await WIKI.db.delete(usersTable).where(eq(usersTable.id, userId))
  await pool.end()
})

/**
 * Inserts a tree entry plus its matching `assets` row — the two share an id, mirroring what
 * `models/assets.ts`'s `upload()` does — with real `data`/`preview` bytes so a purge has something to
 * null out.
 */
async function makeAsset(
  forSiteId: string,
  fileName: string
): Promise<{ id: string; fileName: string }> {
  const entry = await tree.addAsset({
    fileName,
    title: fileName,
    locale: 'en',
    siteId: forSiteId,
    meta: { fileSize: 4, fileExt: 'png', mimeType: 'image/png' }
  })
  await WIKI.db.insert(assetsTable).values({
    id: entry.id,
    siteId: forSiteId,
    authorId: userId,
    fileName,
    fileExt: 'png',
    kind: 'image',
    mimeType: 'image/png',
    fileSize: 4,
    data: Buffer.from('data'),
    preview: Buffer.from('prev')
  })
  return { id: entry.id, fileName: entry.fileName }
}

test('dbStorageModule declares only the purge handler', () => {
  assert.deepEqual(Object.keys(dbStorageModule), ['purge'])
})

test(
  'purge nulls out data and preview for every asset of the target site, leaving tree and metadata intact',
  { skip },
  async () => {
    const purgedAsset = await makeAsset(siteId, `purge-me-${Date.now()}.png`)
    const untouchedAsset = await makeAsset(otherSiteId, `leave-me-${Date.now()}.png`)

    // -> A stale path resolution, as if `/_files/` had resolved this asset before the purge — proves
    //    `purge()` calls `forgetAllPaths()` rather than leaving a request re-serve a cached `hasPreview:
    //    true` for an asset that no longer has one.
    assetServing.pathCache.set(`${siteId}:${purgedAsset.fileName}`, {
      asset: { hasPreview: true } as any,
      cachedAt: Date.now()
    })

    const target = { siteId } as StorageTarget
    await purge(target)

    assert.equal(
      assetServing.pathCache.size,
      0,
      'expected purge to clear the cached path resolutions'
    )

    // -> Content is gone
    assert.equal(await assets.getContent(purgedAsset.id), null)
    const thumbnail = await assets.getThumbnail(purgedAsset.id)
    assert.equal(thumbnail, null)

    // -> Metadata and the tree entry both survive
    const metadata = await assets.getAsset(siteId, purgedAsset.id)
    assert.ok(metadata, 'expected the asset row to still exist')
    assert.equal(metadata!.fileName.startsWith('purge-me-'), true)
    assert.equal(metadata!.fileExt, 'png')
    assert.equal(metadata!.kind, 'image')
    assert.equal(metadata!.mimeType, 'image/png')
    assert.equal(metadata!.fileSize, 4)
    const [treeRow] = await WIKI.db.select().from(treeTable).where(eq(treeTable.id, purgedAsset.id))
    assert.ok(treeRow, 'expected the tree entry to still exist')
    assert.equal(treeRow.fileName, purgedAsset.fileName)
    assert.equal(treeRow.type, 'asset')

    // -> A different site's asset is untouched
    assert.notEqual(await assets.getContent(untouchedAsset.id), null)
    const otherContent = await assets.getContent(untouchedAsset.id)
    assert.equal(otherContent!.data.toString(), 'data')
  }
)

test('purge is a no-op for a site with no assets', { skip }, async () => {
  const [emptySite] = await WIKI.db
    .insert(sitesTable)
    .values({ hostname: `db-storage-purge-empty-${Date.now()}.example.com`, config: {} })
    .returning({ id: sitesTable.id })
  try {
    await assert.doesNotReject(purge({ siteId: emptySite.id } as StorageTarget))
  } finally {
    await WIKI.db.delete(sitesTable).where(eq(sitesTable.id, emptySite.id))
  }
})
