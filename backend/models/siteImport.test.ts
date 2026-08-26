import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { create as createTarball, list as listTarball } from 'tar'
import { and, eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import {
  assets as assetsTable,
  groups as groupsTable,
  navigation as navigationTable,
  pageHistory as pageHistoryTable,
  pages as pagesTable,
  sites as sitesTable,
  tree as treeTable
} from '../db/schema.ts'

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
    const page = await pagesModel.createPage(
      fixtures.siteId,
      { path: 'history-me', title: 'History Me', editor: 'markdown', content: '# v1' },
      { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    )
    await fixtures.db.insert(pageHistoryTable).values({
      pageId: page.id,
      action: 'created',
      locale: 'en',
      path: 'history-me',
      title: 'History Me',
      content: '# v1',
      siteId: fixtures.siteId,
      authorId: fixtures.userId
    })

    // -> A pre-existing history row on the target site that must not survive the import
    const stalePage = await pagesModel.createPage(
      targetSiteId,
      { path: 'stale-history', title: 'Stale History', editor: 'markdown', content: 'stale' },
      { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    )
    const [staleHistory] = await fixtures.db
      .insert(pageHistoryTable)
      .values({
        pageId: stalePage.id,
        action: 'created',
        locale: 'en',
        path: 'stale-history',
        title: 'Stale History',
        content: 'stale',
        siteId: targetSiteId,
        authorId: fixtures.userId
      })
      .returning({ id: pageHistoryTable.id })

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
})
