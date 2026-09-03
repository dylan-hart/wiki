import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { create as createTarball, list as listTarball } from 'tar'
import { and, eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { ensureTemporal } from '../test/temporal.ts'
import {
  assets as assetsTable,
  groups as groupsTable,
  navigation as navigationTable,
  pageHistory as pageHistoryTable,
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
 * `Readable` the way `api/system/transfer.ts`'s content-type parser hands it the raw request stream, and
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
    await ensureTemporal()

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

  test('importSite restores pages, tree, assets, page history and groups into the target site', async () => {
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
    // -> A second revision, so the page carries more than the single `created` history row
    //    `createPage` already recorded.
    await pagesModel.updatePage(
      fixtures.siteId,
      page.id,
      { content: '# Hello import, updated' },
      { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    )

    // -> The target site already holds page history of its own, unrelated to what is about to be
    //    imported -- proving the restore replaces it rather than merging with it.
    const staleTargetPage = await pagesModel.createPage(
      targetSiteId,
      { path: 'target-stale', title: 'Target Stale', editor: 'markdown', content: 'pre-existing' },
      { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    )
    const [staleHistoryRow] = await fixtures.db
      .select()
      .from(pageHistoryTable)
      .where(eq(pageHistoryTable.pageId, staleTargetPage.id))

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
    assert.equal(result.pageHistory, 2)
    assert.ok(result.groups >= 1)
    assert.deepEqual(result.unresolvedRuleSites, [])

    const [importedPage] = await fixtures.db
      .select()
      .from(pagesTable)
      .where(and(eq(pagesTable.siteId, targetSiteId), eq(pagesTable.path, 'import-me')))
    assert.ok(importedPage)
    // -> A fresh id, not the source page's own — see the class-level doc comment on `importSite`
    assert.notEqual(importedPage!.id, page.id)
    assert.equal(importedPage!.authorId, fixtures.userId)

    // -> The pre-existing target-site page-history row is gone, not merged with the imported ones
    assert.ok(staleHistoryRow)
    const [survivingStaleHistoryRow] = await fixtures.db
      .select()
      .from(pageHistoryTable)
      .where(eq(pageHistoryTable.id, staleHistoryRow!.id))
    assert.equal(survivingStaleHistoryRow, undefined)

    // -> Every archived revision is present, and each one's `pageId` resolves to the page that was
    //    just re-inserted under its fresh id.
    const importedHistoryRows = await fixtures.db
      .select()
      .from(pageHistoryTable)
      .where(eq(pageHistoryTable.siteId, targetSiteId))
    assert.equal(importedHistoryRows.length, 2)
    assert.ok(importedHistoryRows.some((h) => h.action === 'created'))
    assert.ok(importedHistoryRows.some((h) => h.action === 'updated'))
    for (const historyRow of importedHistoryRows) {
      assert.equal(historyRow.pageId, importedPage!.id)
      assert.equal(historyRow.authorId, fixtures.userId)
    }

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

  test('importSite leaves isSystem groups (Administrators/Users/Guests) untouched', async () => {
    const [systemGroup] = await fixtures.db
      .insert(groupsTable)
      .values({
        name: 'Users',
        permissions: ['read:pages'],
        rules: [],
        isSystem: true
      })
      .returning()

    const { filePath } = await exportModel.exportSite(fixtures.siteId)

    // -> Simulate the target instance's own Users group having since diverged from whatever it
    //    looked like at export time (a different instance's own seeded row would never match the
    //    source's anyway) -- if the import upserted this by id, as it does for every other group, this
    //    edit would be reverted by the import below.
    await fixtures.db
      .update(groupsTable)
      .set({ permissions: ['read:pages', 'write:pages'] })
      .where(eq(groupsTable.id, systemGroup!.id))
    const [beforeImport] = await fixtures.db
      .select()
      .from(groupsTable)
      .where(eq(groupsTable.id, systemGroup!.id))

    const result = await importModel.importSite(filePath, targetSiteId, fixtures.userId)
    // -> Only the fixture's own non-system group was ever exported
    assert.equal(result.groups, 1)

    const [afterImport] = await fixtures.db
      .select()
      .from(groupsTable)
      .where(eq(groupsTable.id, systemGroup!.id))
    assert.deepEqual(afterImport, beforeImport)

    // -> No second isSystem row was created either
    const systemGroupsByName = await fixtures.db
      .select()
      .from(groupsTable)
      .where(and(eq(groupsTable.name, 'Users'), eq(groupsTable.isSystem, true)))
    assert.equal(systemGroupsByName.length, 1)
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

  test("importSite restores page history, remapping pageId and purging the target's own prior history", async () => {
    // -> Earlier tests in this suite create pages (and, via `createPage`, their own auto-recorded
    //    `created` pageHistory row) on these same shared fixture sites -- cleared first so the counts
    //    asserted below reflect only this test's own rows.
    await fixtures.db.delete(pageHistoryTable).where(eq(pageHistoryTable.siteId, fixtures.siteId))
    await fixtures.db.delete(pageHistoryTable).where(eq(pageHistoryTable.siteId, targetSiteId))

    await pagesModel.createPage(
      fixtures.siteId,
      { path: 'history-me', title: 'History Me', editor: 'markdown', content: '# v1' },
      { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    )
    // -> `createPage` above already recorded this page's one `created` pageHistory row.

    // -> A pre-existing history row on the target site that must not survive the import --
    //    `createPage` records this one automatically too.
    const stalePage = await pagesModel.createPage(
      targetSiteId,
      { path: 'stale-history', title: 'Stale History', editor: 'markdown', content: 'stale' },
      { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    )
    const [staleHistory] = await fixtures.db
      .select()
      .from(pageHistoryTable)
      .where(eq(pageHistoryTable.pageId, stalePage.id))

    const { filePath } = await exportModel.exportSite(fixtures.siteId)
    const result = await importModel.importSite(filePath, targetSiteId, fixtures.userId)
    assert.equal(result.pageHistory, 1)

    const [found] = await fixtures.db
      .select()
      .from(pageHistoryTable)
      .where(eq(pageHistoryTable.id, staleHistory!.id))
    assert.equal(found, undefined)

    const [importedPage] = await fixtures.db
      .select()
      .from(pagesTable)
      .where(and(eq(pagesTable.siteId, targetSiteId), eq(pagesTable.path, 'history-me')))
    assert.ok(importedPage)

    const restoredHistory = await fixtures.db
      .select()
      .from(pageHistoryTable)
      .where(eq(pageHistoryTable.siteId, targetSiteId))
    assert.equal(restoredHistory.length, 1)
    assert.equal(restoredHistory[0]!.pageId, importedPage!.id)
    assert.equal(restoredHistory[0]!.authorId, fixtures.userId)
  })

  test('importSite restores navigation under the target site, purging what was already there', async () => {
    // -> Earlier tests in this suite create pages on these same shared fixture sites, which auto-seeds
    //    a default nav row (`models/navigation.ts#ensureSiteNav`) -- cleared first so this test's own
    //    rows are the only ones counted below.
    await fixtures.db.delete(navigationTable).where(eq(navigationTable.siteId, fixtures.siteId))
    await fixtures.db.delete(navigationTable).where(eq(navigationTable.siteId, targetSiteId))

    await fixtures.db.insert(navigationTable).values({
      items: [{ id: 'a', type: 'link', label: 'Source Home', target: '/' }],
      mode: 'static',
      locale: 'en',
      siteId: fixtures.siteId
    })

    const [staleNav] = await fixtures.db
      .insert(navigationTable)
      .values({
        items: [{ id: 'b', type: 'link', label: 'Stale', target: '/stale' }],
        mode: 'static',
        locale: 'en',
        siteId: targetSiteId
      })
      .returning({ id: navigationTable.id })

    const { filePath } = await exportModel.exportSite(fixtures.siteId)
    const result = await importModel.importSite(filePath, targetSiteId, fixtures.userId)
    assert.equal(result.navigation, 1)

    const [found] = await fixtures.db
      .select()
      .from(navigationTable)
      .where(eq(navigationTable.id, staleNav!.id))
    assert.equal(found, undefined)

    const restoredNav = await fixtures.db
      .select()
      .from(navigationTable)
      .where(eq(navigationTable.siteId, targetSiteId))
    assert.equal(restoredNav.length, 1)
    assert.equal((restoredNav[0]!.items as any[])[0].label, 'Source Home')
    // -> No row left naming the source site
    const leftoverOnSource = await fixtures.db
      .select()
      .from(navigationTable)
      .where(eq(navigationTable.siteId, fixtures.siteId))
    assert.ok(leftoverOnSource.every((n) => n.siteId === fixtures.siteId))
  })

  test('importSite leaves isSystem groups on the target instance untouched', async () => {
    const [administrators] = await fixtures.db
      .insert(groupsTable)
      .values({
        name: 'Administrators',
        permissions: ['manage:system'],
        rules: [],
        isSystem: true
      })
      .returning()

    const { filePath } = await exportModel.exportSite(fixtures.siteId)
    await importModel.importSite(filePath, targetSiteId, fixtures.userId)

    const allGroups = await fixtures.db
      .select()
      .from(groupsTable)
      .where(eq(groupsTable.name, 'Administrators'))
    // -> Exactly the one already there — no imposter duplicate created
    assert.equal(allGroups.length, 1)
    assert.equal(allGroups[0]!.id, administrators!.id)
    assert.equal(allGroups[0]!.isSystem, true)
  })

  test("importSite re-scopes an imported group rule's sites to the target site, and reports an unresolved third site", async () => {
    const unknownSiteId = '00000000-0000-4000-8000-000000000abc'
    const [scopedGroup] = await fixtures.db
      .insert(groupsTable)
      .values({
        name: 'Scoped Editors',
        permissions: [],
        rules: [
          {
            id: 'rule-1',
            name: 'Site-scoped read',
            roles: ['read:pages'],
            match: 'START',
            mode: 'ALLOW',
            path: '',
            locales: [],
            sites: [fixtures.siteId, unknownSiteId]
          }
        ]
      })
      .returning()

    const page = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'scoped', title: 'Scoped', editor: 'markdown', content: 'x' },
      { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    )

    const { groups: groupsAccessModel } = await import('./groups.ts')
    await groupsAccessModel.reloadCache()
    const actor = {
      groupIds: [scopedGroup!.id],
      permissions: [] as string[]
    }
    const sourcePageRef = {
      path: page.path,
      locale: page.locale,
      siteId: fixtures.siteId,
      classification: null,
      tags: []
    }
    const beforeAccess = groupsAccessModel.checkAccess(actor, 'read:pages', sourcePageRef)
    assert.equal(beforeAccess, true)

    const { filePath } = await exportModel.exportSite(fixtures.siteId)
    const result = await importModel.importSite(filePath, targetSiteId, fixtures.userId)

    assert.ok(
      result.unresolvedRuleSites.some(
        (r) => r.groupId === scopedGroup!.id && r.siteId === unknownSiteId
      )
    )

    const [importedGroup] = await fixtures.db
      .select()
      .from(groupsTable)
      .where(eq(groupsTable.id, scopedGroup!.id))
    const importedRule = (importedGroup!.rules as any[])[0]
    assert.ok(importedRule.sites.includes(targetSiteId))
    assert.ok(!importedRule.sites.includes(fixtures.siteId))
    assert.ok(importedRule.sites.includes(unknownSiteId))

    await groupsAccessModel.reloadCache()
    const [importedPage] = await fixtures.db
      .select()
      .from(pagesTable)
      .where(and(eq(pagesTable.siteId, targetSiteId), eq(pagesTable.path, 'scoped')))
    const restoredPageRef = {
      path: importedPage!.path,
      locale: importedPage!.locale,
      siteId: targetSiteId,
      classification: null,
      tags: []
    }
    const afterAccess = groupsAccessModel.checkAccess(actor, 'read:pages', restoredPageRef)
    assert.equal(afterAccess, true)
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

  test('importSite chunks page/tree inserts past one bind-parameter batch, and still rolls back atomically when a later chunk fails', async () => {
    // -> A dedicated source site rather than `fixtures.siteId`, so this test's synthetic bulk content
    //    -- built specifically to overrun both `pages`' and `tree`'s per-statement chunk size (see
    //    `PAGE_INSERT_CHUNK_SIZE`/`TREE_INSERT_CHUNK_SIZE` in `siteImport.ts`) -- never leaks into any
    //    other test in this file's shared fixture site.
    const [bulkSourceSite] = await fixtures.db
      .insert(sitesTable)
      .values({
        hostname: 'import-bulk-source.localhost',
        isEnabled: true,
        config: { locales: { primary: 'en' } }
      })
      .returning({ id: sitesTable.id })
    const bulkSourceSiteId = bulkSourceSite!.id
    WIKI.sites[bulkSourceSiteId] = { id: bulkSourceSiteId, config: { locales: { primary: 'en' } } }

    // -> One real page, created through the model so its row has every column a genuine export would
    //    produce -- then exported and used as a template. `ROW_COUNT` synthetic pages/tree entries are
    //    cloned from it below rather than created one at a time through `pagesModel`, which is what
    //    keeps this test fast despite the row count.
    await pagesModel.createPage(
      bulkSourceSiteId,
      { path: 'template', title: 'Template', editor: 'markdown', content: 'template content' },
      { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    )
    const { filePath: templateArchivePath } = await exportModel.exportSite(bulkSourceSiteId)
    const templateEntries = await readArchiveEntries(templateArchivePath)
    const [templatePageRow] = JSON.parse(templateEntries['pages.json']!.toString('utf8'))
    const [templateTreeRow] = JSON.parse(templateEntries['tree.json']!.toString('utf8'))

    // -> One row more than a full `pages` chunk (1927) *and* more than a full `tree` chunk (4681) at
    //    once: with exactly one tree entry per page and no folders, both tables end up with this same
    //    row count, so a single archive exercises multi-statement chunking on both tables together.
    const ROW_COUNT = 4682

    /**
     * Clones the template page/tree rows into `rowCount` pairs, each with its own fresh id and a
     * unique path/fileName (both tables enforce siteId+locale+path/fileName uniqueness). When
     * `duplicateFirstIdAtEnd` is set, the very last pair reuses the first pair's id instead of a
     * fresh one -- landing a primary-key collision in the last (and only the last) insert chunk, so
     * every earlier chunk has already been applied inside the transaction before the failure hits.
     */
    function buildBulkRows(rowCount: number, { duplicateFirstIdAtEnd = false } = {}) {
      const pageRows: Record<string, any>[] = []
      const treeRows: Record<string, any>[] = []
      let firstId: string | undefined
      for (let i = 0; i < rowCount; i++) {
        const id = duplicateFirstIdAtEnd && i === rowCount - 1 ? firstId! : crypto.randomUUID()
        firstId ??= id
        pageRows.push({ ...templatePageRow, id, path: `bulk-${i}` })
        treeRows.push({ ...templateTreeRow, id, fileName: `bulk-${i}` })
      }
      return { pageRows, treeRows }
    }

    async function writeBulkArchive(
      fileName: string,
      rowCount: number,
      opts?: { duplicateFirstIdAtEnd?: boolean }
    ): Promise<string> {
      const { pageRows, treeRows } = buildBulkRows(rowCount, opts)
      const archivePath = path.join(dataPath, fileName)
      await writeArchive(archivePath, {
        ...templateEntries,
        'pages.json': Buffer.from(JSON.stringify(pageRows)),
        'tree.json': Buffer.from(JSON.stringify(treeRows))
      })
      return archivePath
    }

    // -> Every row lands: the archive's page/tree counts are each larger than one chunk, so this only
    //    passes if `importSite` actually loops over every chunk rather than stopping after the first.
    const [okTargetSite] = await fixtures.db
      .insert(sitesTable)
      .values({
        hostname: 'import-bulk-target-ok.localhost',
        isEnabled: true,
        config: { locales: { primary: 'en' } }
      })
      .returning({ id: sitesTable.id })
    const okTargetSiteId = okTargetSite!.id

    const okArchivePath = await writeBulkArchive('bulk-ok.tar.gz', ROW_COUNT)
    const okResult = await importModel.importSite(okArchivePath, okTargetSiteId, fixtures.userId)
    assert.equal(okResult.pages, ROW_COUNT)
    assert.equal(okResult.tree, ROW_COUNT)

    const insertedPages = await fixtures.db
      .select({ id: pagesTable.id })
      .from(pagesTable)
      .where(eq(pagesTable.siteId, okTargetSiteId))
    assert.equal(insertedPages.length, ROW_COUNT)

    const insertedTree = await fixtures.db
      .select({ id: treeTable.id })
      .from(treeTable)
      .where(eq(treeTable.siteId, okTargetSiteId))
    assert.equal(insertedTree.length, ROW_COUNT)

    // -> Rolls back as a unit even when the failure lands in a later chunk: with `ROW_COUNT` = 4682,
    //    the page insert splits into chunks of 1927/1927/828 -- the duplicated id falls in that last,
    //    828-row chunk, so the first two chunks (3854 rows) are already applied inside the transaction
    //    by the time the third one's primary-key violation aborts it. If those earlier chunks weren't
    //    rolled back along with the failing one, the target site would be left with 3854 stray pages
    //    instead of just the one that was there before the attempt.
    const [failTargetSite] = await fixtures.db
      .insert(sitesTable)
      .values({
        hostname: 'import-bulk-target-fail.localhost',
        isEnabled: true,
        config: { locales: { primary: 'en' } }
      })
      .returning({ id: sitesTable.id })
    const failTargetSiteId = failTargetSite!.id
    WIKI.sites[failTargetSiteId] = { id: failTargetSiteId, config: { locales: { primary: 'en' } } }

    const preExistingPage = await pagesModel.createPage(
      failTargetSiteId,
      { path: 'must-survive', title: 'Must Survive', editor: 'markdown', content: 'must survive' },
      { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    )

    const failArchivePath = await writeBulkArchive('bulk-fail.tar.gz', ROW_COUNT, {
      duplicateFirstIdAtEnd: true
    })
    await assert.rejects(importModel.importSite(failArchivePath, failTargetSiteId, fixtures.userId))

    const [survivor] = await fixtures.db
      .select()
      .from(pagesTable)
      .where(eq(pagesTable.id, preExistingPage.id))
    assert.ok(survivor)

    const leftoverPages = await fixtures.db
      .select({ id: pagesTable.id })
      .from(pagesTable)
      .where(eq(pagesTable.siteId, failTargetSiteId))
    assert.equal(leftoverPages.length, 1)
  })

  test('importSite chunks pageHistory/navigation inserts past one bind-parameter batch, and still rolls back atomically when a later chunk fails', async () => {
    // -> A dedicated source site, same isolation reasoning as the pages/tree bulk test above.
    const [bulkSourceSite] = await fixtures.db
      .insert(sitesTable)
      .values({
        hostname: 'import-bulk-history-nav-source.localhost',
        isEnabled: true,
        config: { locales: { primary: 'en' } }
      })
      .returning({ id: sitesTable.id })
    const bulkSourceSiteId = bulkSourceSite!.id
    WIKI.sites[bulkSourceSiteId] = { id: bulkSourceSiteId, config: { locales: { primary: 'en' } } }

    // -> One real page, created through the model so it auto-records one `pageHistory` row and (via
    //    `models/navigation.ts#ensureSiteNav`) the site's one default `navigation` row -- both used as
    //    templates for the synthetic bulk rows below.
    await pagesModel.createPage(
      bulkSourceSiteId,
      { path: 'template', title: 'Template', editor: 'markdown', content: 'template content' },
      { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    )
    const { filePath: templateArchivePath } = await exportModel.exportSite(bulkSourceSiteId)
    const templateEntries = await readArchiveEntries(templateArchivePath)
    const [templatePageHistoryRow] = JSON.parse(
      templateEntries['pageHistory.json']!.toString('utf8')
    )
    const [templateNavigationRow] = JSON.parse(templateEntries['navigation.json']!.toString('utf8'))

    // -> One row more than a full `navigation` chunk (`NAVIGATION_INSERT_CHUNK_SIZE` = 13107): with the
    //    same row count applied to `pageHistory` too, this also lands well past its own (smaller,
    //    `PAGE_HISTORY_INSERT_CHUNK_SIZE` = 4681) chunk boundary, so one archive exercises multi-statement
    //    chunking on both tables together.
    const ROW_COUNT = 13108

    /**
     * Clones the template pageHistory/navigation rows into `rowCount` pairs, each with its own fresh
     * id. `pageHistory` has no uniqueness constraint beyond its (always-freshly-randomized-on-import)
     * id, so nothing about its clones can be made to collide from archive data alone -- the happy path
     * below is what proves its chunking. `navigation` enforces a unique `(siteId, locale)` index, which
     * `null` locales (the per-tree-entry-override shape) never trip; when `duplicateLocaleAtEnd` is set,
     * the very first and very last navigation rows share one non-null locale instead, landing a unique
     * violation in the last (and only the last) insert chunk once both are attempted -- so every earlier
     * chunk has already been applied inside the transaction by the time it fails.
     */
    function buildBulkRows(rowCount: number, { duplicateLocaleAtEnd = false } = {}) {
      const historyRows: Record<string, any>[] = []
      const navRows: Record<string, any>[] = []
      for (let i = 0; i < rowCount; i++) {
        historyRows.push({ ...templatePageHistoryRow, id: crypto.randomUUID() })
        const locale = duplicateLocaleAtEnd && (i === 0 || i === rowCount - 1) ? 'x-bulk-dup' : null
        navRows.push({ ...templateNavigationRow, id: crypto.randomUUID(), locale })
      }
      return { historyRows, navRows }
    }

    async function writeBulkArchive(
      fileName: string,
      rowCount: number,
      opts?: { duplicateLocaleAtEnd?: boolean }
    ): Promise<string> {
      const { historyRows, navRows } = buildBulkRows(rowCount, opts)
      const archivePath = path.join(dataPath, fileName)
      await writeArchive(archivePath, {
        ...templateEntries,
        'pageHistory.json': Buffer.from(JSON.stringify(historyRows)),
        'navigation.json': Buffer.from(JSON.stringify(navRows))
      })
      return archivePath
    }

    // -> Every row lands: the archive's pageHistory/navigation counts are each larger than one chunk,
    //    so this only passes if `importSite` actually loops over every chunk rather than stopping after
    //    the first.
    const [okTargetSite] = await fixtures.db
      .insert(sitesTable)
      .values({
        hostname: 'import-bulk-history-nav-target-ok.localhost',
        isEnabled: true,
        config: { locales: { primary: 'en' } }
      })
      .returning({ id: sitesTable.id })
    const okTargetSiteId = okTargetSite!.id

    const okArchivePath = await writeBulkArchive('bulk-history-nav-ok.tar.gz', ROW_COUNT)
    const okResult = await importModel.importSite(okArchivePath, okTargetSiteId, fixtures.userId)
    assert.equal(okResult.pageHistory, ROW_COUNT)
    assert.equal(okResult.navigation, ROW_COUNT)

    const insertedHistory = await fixtures.db
      .select({ id: pageHistoryTable.id })
      .from(pageHistoryTable)
      .where(eq(pageHistoryTable.siteId, okTargetSiteId))
    assert.equal(insertedHistory.length, ROW_COUNT)

    const insertedNav = await fixtures.db
      .select({ id: navigationTable.id })
      .from(navigationTable)
      .where(eq(navigationTable.siteId, okTargetSiteId))
    assert.equal(insertedNav.length, ROW_COUNT)

    // -> Rolls back as a unit even when the failure lands in a later chunk: with `ROW_COUNT` = 13108,
    //    the navigation insert splits into chunks of 13107/1 -- the duplicated locale's second half
    //    falls in that last, one-row chunk, so the entire first chunk (13107 rows) is already applied
    //    inside the transaction by the time the second chunk's unique-constraint violation aborts it.
    //    If that first chunk weren't rolled back along with the failing one, the target site would be
    //    left with 13107 stray navigation rows instead of just the one that was there before the
    //    attempt.
    const [failTargetSite] = await fixtures.db
      .insert(sitesTable)
      .values({
        hostname: 'import-bulk-history-nav-target-fail.localhost',
        isEnabled: true,
        config: { locales: { primary: 'en' } }
      })
      .returning({ id: sitesTable.id })
    const failTargetSiteId = failTargetSite!.id

    const [preExistingNav] = await fixtures.db
      .insert(navigationTable)
      .values({
        items: [{ id: 'must-survive', type: 'link', label: 'Must Survive', target: '/' }],
        mode: 'static',
        locale: 'must-survive',
        siteId: failTargetSiteId
      })
      .returning({ id: navigationTable.id })

    const failArchivePath = await writeBulkArchive('bulk-history-nav-fail.tar.gz', ROW_COUNT, {
      duplicateLocaleAtEnd: true
    })
    await assert.rejects(importModel.importSite(failArchivePath, failTargetSiteId, fixtures.userId))

    const [survivor] = await fixtures.db
      .select()
      .from(navigationTable)
      .where(eq(navigationTable.id, preExistingNav!.id))
    assert.ok(survivor)

    const leftoverNav = await fixtures.db
      .select({ id: navigationTable.id })
      .from(navigationTable)
      .where(eq(navigationTable.siteId, failTargetSiteId))
    assert.equal(leftoverNav.length, 1)

    const leftoverHistory = await fixtures.db
      .select({ id: pageHistoryTable.id })
      .from(pageHistoryTable)
      .where(eq(pageHistoryTable.siteId, failTargetSiteId))
    assert.equal(leftoverHistory.length, 0)
  })
})
