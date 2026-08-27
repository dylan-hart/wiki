import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { create as createTarball, list as listTarball } from 'tar'
import { and, eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { readArchive } from './siteImport.ts'
import {
  assets as assetsTable,
  groups as groupsTable,
  pages as pagesTable,
  sites as sitesTable,
  tree as treeTable
} from '../db/schema.ts'

/** Stages a `{ name: Buffer }` map to real files under `dir`, then tars them into a fresh archive. */
async function buildArchive(dir: string, entries: Record<string, Buffer>): Promise<string> {
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-import-test-build-'))
  try {
    for (const [name, data] of Object.entries(entries)) {
      const entryPath = path.join(stagingDir, name)
      await fs.mkdir(path.dirname(entryPath), { recursive: true })
      await fs.writeFile(entryPath, data)
    }
    const filePath = path.join(dir, `${crypto.randomUUID()}.tar.gz`)
    await createTarball({ gzip: true, file: filePath, cwd: stagingDir }, Object.keys(entries))
    return filePath
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true })
  }
}

/**
 * `readArchive`'s size ceilings, in isolation — no database, no `WIKI` global. Custom `maxEntryBytes`
 * / `maxTotalBytes` are what make this fast: tripping the real production ceilings (500 MB / 2 GB)
 * would mean building gigabyte fixtures, where a handful of small archives and a tiny override prove
 * the exact same abort logic.
 */
describe('readArchive size ceilings (pure, no DB)', () => {
  let readArchive: typeof import('./siteImport.ts').readArchive
  let tmpDir: string

  before(async () => {
    ;({ readArchive } = await import('./siteImport.ts'))
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-import-readarchive-test-'))
  })

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('readArchive aborts once a single entry exceeds the per-entry cap', async () => {
    const filePath = await buildArchive(tmpDir, {
      'manifest.json': Buffer.from('{}'),
      'assets/oversized.data': Buffer.alloc(50, 'x')
    })

    await assert.rejects(
      readArchive(filePath, { maxEntryBytes: 20, maxTotalBytes: 1000 }),
      /assets\/oversized\.data is 50 decompressed bytes, over the 20-byte single-entry limit/
    )
  })

  test('readArchive aborts once the running decompressed total exceeds the ceiling', async () => {
    const filePath = await buildArchive(tmpDir, {
      'a.json': Buffer.alloc(20, 'a'),
      'b.json': Buffer.alloc(20, 'b'),
      'c.json': Buffer.alloc(20, 'c')
    })

    await assert.rejects(
      readArchive(filePath, { maxEntryBytes: 1000, maxTotalBytes: 30 }),
      /decompressed size exceeds the 30-byte import limit/
    )
  })

  test('readArchive stays under both ceilings when the archive is within budget', async () => {
    const filePath = await buildArchive(tmpDir, {
      'manifest.json': Buffer.from('{"ok":true}'),
      'assets/abc.data': Buffer.from('asset bytes'),
      'assets/abc.preview': Buffer.from('preview bytes')
    })

    const result = await readArchive(filePath, { maxEntryBytes: 1000, maxTotalBytes: 1000 })

    // -> The JSON entry is kept in memory ...
    assert.deepEqual(result.entries['manifest.json'], Buffer.from('{"ok":true}'))
    // -> ... but the asset blobs are staged to disk instead, not held as in-memory Buffers at all
    assert.equal(result.entries['assets/abc.data'], undefined)
    assert.equal(result.entries['assets/abc.preview'], undefined)

    const dataPath = result.assetBlobs['assets/abc.data']
    const previewPath = result.assetBlobs['assets/abc.preview']
    assert.ok(dataPath, 'expected assets/abc.data to have been staged to a file')
    assert.ok(previewPath, 'expected assets/abc.preview to have been staged to a file')
    assert.equal((await fs.readFile(dataPath)).toString('utf8'), 'asset bytes')
    assert.equal((await fs.readFile(previewPath)).toString('utf8'), 'preview bytes')

    await fs.rm(result.stagingDir, { recursive: true, force: true })
  })
})

/**
 * `importModel.saveUpload` in isolation — no database, no real HTTP request. Feeds it a plain
 * `Readable` the way `api/system.ts`'s content-type parser hands it the raw request stream, and
 * checks the same things that parser used to check against a fully-buffered `Buffer` before this
 * task streamed the save.
 */
describe('importModel.saveUpload (pure, no DB)', () => {
  let importModel: typeof import('./siteImport.ts').importModel
  let dataPath: string
  let Readable: typeof import('node:stream').Readable

  before(async () => {
    ;({ importModel } = await import('./siteImport.ts'))
    ;({ Readable } = await import('node:stream'))
    dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-import-saveupload-test-'))
    ;(globalThis as any).WIKI = { ROOTPATH: process.cwd(), config: { dataPath } }
  })

  after(async () => {
    await fs.rm(dataPath, { recursive: true, force: true })
    delete (globalThis as any).WIKI
  })

  test('saveUpload streams the body to a file under <dataPath>/imports rather than buffering it', async () => {
    const gzipHeader = Buffer.from([0x1f, 0x8b, 0x08, 0x00])
    const body = Buffer.concat([gzipHeader, Buffer.from('rest of the archive bytes')])

    const filePath = await importModel.saveUpload(Readable.from([body]), 1024 * 1024)

    assert.match(filePath, /imports[/\\].+\.tar\.gz$/)
    assert.deepEqual(await fs.readFile(filePath), body)
  })

  test('saveUpload rejects a body over bodyLimit and removes the partial file', async () => {
    const chunks = [Buffer.from([0x1f, 0x8b]), Buffer.alloc(100, 'a'), Buffer.alloc(100, 'b')]
    const before = await fs.readdir(path.join(dataPath, 'imports'))

    let caught: any
    try {
      await importModel.saveUpload(Readable.from(chunks), 50)
    } catch (err) {
      caught = err
    }
    assert.ok(caught, 'expected saveUpload to reject')
    assert.equal(caught.statusCode, 413)

    const after = await fs.readdir(path.join(dataPath, 'imports'))
    assert.equal(after.length, before.length, 'expected the partial upload to have been removed')
  })

  test('saveUpload rejects a body whose first bytes are not the gzip magic number', async () => {
    const before = await fs.readdir(path.join(dataPath, 'imports'))

    let caught: any
    try {
      await importModel.saveUpload(Readable.from([Buffer.from('not a gzip archive at all')]), 1024)
    } catch (err) {
      caught = err
    }
    assert.ok(caught, 'expected saveUpload to reject')
    assert.equal(caught.statusCode, 400)

    const after = await fs.readdir(path.join(dataPath, 'imports'))
    assert.equal(after.length, before.length, 'expected the rejected upload to have been removed')
  })

  test('saveUpload rejects an empty body', async () => {
    await assert.rejects(importModel.saveUpload(Readable.from([]), 1024), /No archive was sent/)
  })
})

/**
 * `readArchive`'s two ceilings (OpenProject #2213), exercised directly against real tar fixtures
 * rather than through the DB-backed `importSite` round trip below — no `WIKI` global and no database
 * needed, since `readArchive` itself touches neither.
 */
describe('siteImport.readArchive — decompressed-size ceilings (#2213)', () => {
  let workDir: string

  before(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-readarchive-test-'))
  })

  after(async () => {
    await fs.rm(workDir, { recursive: true, force: true })
  })

  /** Builds a small gzipped tarball out of `{ name: content }`, the same helper shape as below. */
  async function buildArchive(
    name: string,
    entries: Record<string, string | Buffer>
  ): Promise<string> {
    const stagingDir = await fs.mkdtemp(path.join(workDir, 'staging-'))
    for (const [entryName, data] of Object.entries(entries)) {
      await fs.writeFile(path.join(stagingDir, entryName), data)
    }
    const filePath = path.join(workDir, name)
    await createTarball({ gzip: true, file: filePath, cwd: stagingDir }, Object.keys(entries))
    return filePath
  }

  test('reads back every entry normally, well under either ceiling', async () => {
    const filePath = await buildArchive('normal.tar.gz', {
      'a.json': '{"ok":true}',
      'b.txt': 'hello'
    })
    const entries = await readArchive(filePath)
    assert.equal(entries['a.json']!.toString('utf8'), '{"ok":true}')
    assert.equal(entries['b.txt']!.toString('utf8'), 'hello')
  })

  test('aborts once a single entry decompresses past the per-entry ceiling', async () => {
    const filePath = await buildArchive('oversized-entry.tar.gz', {
      'huge.bin': Buffer.alloc(2048, 'x')
    })

    await assert.rejects(readArchive(filePath, { maxEntryBytes: 1024 }), (err: any) => {
      assert.match(err.message, /huge\.bin/)
      assert.match(err.message, /per-entry limit/)
      return true
    })
  })

  test('aborts once the total across every entry passes the aggregate ceiling, even with no single oversized entry', async () => {
    // -> Five entries, each safely under the per-entry ceiling, whose sum still passes the aggregate
    //    one -- proves the two limits are independent checks, not the same one twice.
    const filePath = await buildArchive('oversized-aggregate.tar.gz', {
      'one.bin': Buffer.alloc(300, 'a'),
      'two.bin': Buffer.alloc(300, 'b'),
      'three.bin': Buffer.alloc(300, 'c'),
      'four.bin': Buffer.alloc(300, 'd'),
      'five.bin': Buffer.alloc(300, 'e')
    })

    await assert.rejects(
      readArchive(filePath, { maxEntryBytes: 1024, maxTotalBytes: 1024 }),
      /total decompressed size exceeds/
    )
  })

  test('a normal read is unaffected by the override defaulting mechanism itself', async () => {
    const filePath = await buildArchive('defaults.tar.gz', { 'small.txt': 'fits easily' })
    // -> No `limits` argument at all -- the real, module-level ceilings apply, exactly as
    //    `importSite` calls it.
    const entries = await readArchive(filePath)
    assert.equal(entries['small.txt']!.toString('utf8'), 'fits easily')
  })
})

/**
 * `importSite` is the mirror image of `exportSite`: read the archive back apart, then a burst of SQL
 * orchestration inside one transaction. Same reasoning as `export.test.ts` for running it against a
 * real, migrated database rather than mocking the query builder — and the two suites share a fixture
 * shape (`models/pages.ts`-created pages, a hand-inserted asset) so a round trip through the real
 * `exportSite` is what most of these tests import back apart, rather than a hand-built fixture archive
 * only this suite would ever produce.
 */
describe('import.importSite (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let exportModel: typeof import('./export.ts').exportModel
  let importModel: typeof import('./siteImport.ts').importModel
  let pagesModel: typeof import('./pages.ts').pages
  let dataPath: string
  let targetSiteId: string

  before(async () => {
    // -> Node 25 (this sandbox) has no native `Temporal` yet -- Node 26 does, per this repo's engine
    //    requirement. Polyfilled only when missing, so this is a no-op on a real Node 26 runtime --
    //    same pattern as `modules/storage/disk/storage.test.ts`'s own `before()`. The package
    //    polyfills the `Temporal` global itself but, unlike Node 26, does not also patch
    //    `Date.prototype.toTemporalInstant()` -- `purgeExpired()` uses that conversion.
    if (typeof Temporal === 'undefined') {
      const polyfill = await import('@js-temporal/polyfill')
      ;(globalThis as any).Temporal = polyfill.Temporal
      ;(Date.prototype as any).toTemporalInstant = function (this: Date) {
        return polyfill.toTemporalInstant.call(this)
      }
    }

    fixtures = await setupTestDb()
    ;({ exportModel } = await import('./export.ts'))
    ;({ importModel } = await import('./siteImport.ts'))
    ;({ pages: pagesModel } = await import('./pages.ts'))

    dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-import-test-'))
    WIKI.config.dataPath = dataPath

    const [targetSite] = await fixtures.db
      .insert(sitesTable)
      .values({
        hostname: 'import-target.localhost',
        isEnabled: true,
        config: { locales: { primary: 'en' } }
      })
      .returning({ id: sitesTable.id })
    targetSiteId = targetSite!.id
    WIKI.sites[targetSiteId] = { id: targetSiteId, config: { locales: { primary: 'en' } } }
  })

  after(async () => {
    await fs.rm(dataPath, { recursive: true, force: true })
    await teardownTestDb()
  })

  /** Reads every entry of a gzipped tar file back into a `{ name: Buffer }` map. */
  async function readArchiveEntries(filePath: string): Promise<Record<string, Buffer>> {
    const entries: Record<string, Buffer> = {}
    await listTarball({
      file: filePath,
      onReadEntry: (entry) => {
        // -> `create()` emits a directory entry for `assets/` itself, ahead of the files inside it.
        if (entry.type !== 'File') {
          return
        }
        const chunks: Buffer[] = []
        entry.on('data', (chunk) => chunks.push(chunk))
        entry.on('end', () => {
          entries[entry.path] = Buffer.concat(chunks)
        })
      }
    })
    return entries
  }

  /**
   * Writes a `{ name: Buffer }` map back out as a gzipped tar file, for building a doctored archive.
   * `tar`'s `Pack` only ever archives real files (it lstats each path itself), so each entry is staged
   * to a throwaway directory first, the same way `models/export.ts`'s `exportSite` does.
   */
  async function writeArchive(filePath: string, entries: Record<string, Buffer>): Promise<void> {
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-import-test-archive-'))
    try {
      for (const [name, data] of Object.entries(entries)) {
        const entryPath = path.join(stagingDir, name)
        await fs.mkdir(path.dirname(entryPath), { recursive: true })
        await fs.writeFile(entryPath, data)
      }
      await createTarball({ gzip: true, file: filePath, cwd: stagingDir }, Object.keys(entries))
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true })
    }
  }

  test('importSite restores pages, tree, assets and groups into the target site', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'import-me',
        title: 'Import Me',
        editor: 'markdown',
        content: '# Hello import'
      },
      { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    )

    const assetData = Buffer.from('fake asset bytes')
    const [asset] = await fixtures.db
      .insert(assetsTable)
      .values({
        fileName: 'imported.txt',
        fileExt: 'txt',
        mimeType: 'text/plain',
        fileSize: assetData.length,
        data: assetData,
        authorId: fixtures.userId,
        siteId: fixtures.siteId
      })
      .returning({ id: assetsTable.id })

    const { filePath } = await exportModel.exportSite(fixtures.siteId)

    const result = await importModel.importSite(filePath, targetSiteId, fixtures.userId)
    assert.equal(result.pages, 1)
    assert.equal(result.assets, 1)
    // -> The asset was inserted directly rather than through `models/assets.ts`, so it has no tree
    //    entry of its own here — only the page's
    assert.ok(result.tree >= 1)
    assert.ok(result.groups >= 1)

    const [importedPage] = await fixtures.db
      .select()
      .from(pagesTable)
      .where(and(eq(pagesTable.siteId, targetSiteId), eq(pagesTable.path, 'import-me')))
    assert.ok(importedPage)
    // -> A fresh id, not the source page's own — see the class-level doc comment on `importSite`
    assert.notEqual(importedPage!.id, page.id)
    assert.equal(importedPage!.authorId, fixtures.userId)

    // -> The page's tree entry must have followed it to the exact same new id
    const [pageTreeEntry] = await fixtures.db
      .select()
      .from(treeTable)
      .where(and(eq(treeTable.siteId, targetSiteId), eq(treeTable.type, 'page')))
    assert.ok(pageTreeEntry)
    assert.equal(pageTreeEntry!.id, importedPage!.id)

    const [importedAsset] = await fixtures.db
      .select()
      .from(assetsTable)
      .where(and(eq(assetsTable.siteId, targetSiteId), eq(assetsTable.fileName, 'imported.txt')))
    assert.ok(importedAsset)
    assert.notEqual(importedAsset!.id, asset!.id)
    assert.deepEqual(importedAsset!.data, assetData)

    const [importedGroup] = await fixtures.db
      .select()
      .from(groupsTable)
      .where(eq(groupsTable.id, fixtures.groupId))
    assert.ok(importedGroup)
  })

  test("importSite replaces the target site's existing content rather than merging with it", async () => {
    const stalePage = await pagesModel.createPage(
      targetSiteId,
      { path: 'stale', title: 'Stale', editor: 'markdown', content: 'not in the archive' },
      { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    )

    const { filePath } = await exportModel.exportSite(fixtures.siteId)
    await importModel.importSite(filePath, targetSiteId, fixtures.userId)

    const [found] = await fixtures.db
      .select()
      .from(pagesTable)
      .where(eq(pagesTable.id, stalePage.id))
    assert.equal(found, undefined)
  })

  test('importSite rejects an archive with an unsupported format version, before touching the database', async () => {
    const stalePage = await pagesModel.createPage(
      targetSiteId,
      { path: 'still-here', title: 'Still Here', editor: 'markdown', content: 'untouched' },
      { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    )

    const { filePath } = await exportModel.exportSite(fixtures.siteId)
    const entries = await readArchiveEntries(filePath)
    entries['manifest.json'] = Buffer.from(JSON.stringify({ formatVersion: 999 }))

    const badArchive = path.join(dataPath, 'bad-version.tar.gz')
    await writeArchive(badArchive, entries)

    await assert.rejects(
      importModel.importSite(badArchive, targetSiteId, fixtures.userId),
      /version/
    )

    // -> Rejected before any table was touched, so what was already on the target site is exactly
    //    as it was
    const [found] = await fixtures.db
      .select()
      .from(pagesTable)
      .where(eq(pagesTable.id, stalePage.id))
    assert.ok(found)
  })

  test('importSite rejects an archive missing a required entry', async () => {
    const { filePath } = await exportModel.exportSite(fixtures.siteId)
    const entries = await readArchiveEntries(filePath)
    delete entries['groups.json']

    const badArchive = path.join(dataPath, 'missing-entry.tar.gz')
    await writeArchive(badArchive, entries)

    await assert.rejects(
      importModel.importSite(badArchive, targetSiteId, fixtures.userId),
      /groups\.json/
    )
  })

  test('importSite rejects an unknown target site', async () => {
    const { filePath } = await exportModel.exportSite(fixtures.siteId)
    await assert.rejects(
      importModel.importSite(filePath, '00000000-0000-0000-0000-000000000000', fixtures.userId),
      /does not exist/
    )
  })

  test('importSite rolls back entirely when the restore fails partway through the transaction', async () => {
    const stalePage = await pagesModel.createPage(
      targetSiteId,
      { path: 'survivor', title: 'Survivor', editor: 'markdown', content: 'must survive' },
      { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    )

    const { filePath } = await exportModel.exportSite(fixtures.siteId)
    const entries = await readArchiveEntries(filePath)
    // -> Duplicate one page row so the insert violates the primary key partway through the
    //    transaction, after the (valid) group upsert immediately before it has already run
    const pages = JSON.parse(entries['pages.json']!.toString('utf8'))
    entries['pages.json'] = Buffer.from(JSON.stringify([...pages, ...pages]))

    const badArchive = path.join(dataPath, 'duplicate-pages.tar.gz')
    await writeArchive(badArchive, entries)

    await assert.rejects(importModel.importSite(badArchive, targetSiteId, fixtures.userId))

    // -> Nothing was left half-restored: the page that was on the target site before the attempt is
    //    still there, exactly because the group upsert that ran before the failing insert was rolled
    //    back along with it
    const [found] = await fixtures.db
      .select()
      .from(pagesTable)
      .where(eq(pagesTable.id, stalePage.id))
    assert.ok(found)
  })
})
