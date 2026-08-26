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
  let groupsModel: typeof import('./groups.ts').groups
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
    ;({ groups: groupsModel } = await import('./groups.ts'))

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

  test("importSite re-scopes an imported group rule's sites[] to the target site, and surfaces an unresolvable one", async () => {
    const unknownSiteId = '00000000-0000-0000-0000-0000000000ff'
    const [ruleGroup] = await fixtures.db
      .insert(groupsTable)
      .values({
        name: 'Rule Import Group',
        permissions: [],
        rules: [
          {
            id: crypto.randomUUID(),
            name: 'Source site read',
            roles: ['read:pages'],
            match: 'START',
            mode: 'ALLOW',
            path: '',
            locales: [],
            sites: [fixtures.siteId]
          },
          {
            id: crypto.randomUUID(),
            name: 'Unknown site rule',
            roles: ['read:pages'],
            match: 'START',
            mode: 'ALLOW',
            path: '',
            locales: [],
            sites: [unknownSiteId]
          }
        ]
      })
      .returning({ id: groupsTable.id })

    await pagesModel.createPage(
      fixtures.siteId,
      { path: 'rule-scoped', title: 'Rule Scoped', editor: 'markdown', content: 'content' },
      { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    )

    // -> Captured against the ORIGINAL rules, before the import overwrites this same group row —
    //    this is the "the way it did against the source page" baseline the restored-page check
    //    below is compared against.
    await groupsModel.reloadCache()
    const actor = { permissions: [], groupIds: [ruleGroup!.id] }
    const sourceAccess = groupsModel.checkAccess(actor, 'read:pages', {
      path: 'rule-scoped',
      locale: 'en',
      siteId: fixtures.siteId,
      classification: null
    })
    assert.equal(sourceAccess, true)

    const { filePath } = await exportModel.exportSite(fixtures.siteId)
    const result = await importModel.importSite(filePath, targetSiteId, fixtures.userId)

    // -> The rule naming the source site was rewritten to name the target site instead
    const [importedGroup] = await fixtures.db
      .select({ rules: groupsTable.rules })
      .from(groupsTable)
      .where(eq(groupsTable.id, ruleGroup!.id))
    const importedRules = importedGroup!.rules as any[]
    const rewritten = importedRules.find((rule) => rule.name === 'Source site read')
    assert.deepEqual(rewritten.sites, [targetSiteId])

    // -> The rule naming a site that exists on neither side was left alone but surfaced, not stored
    //    silently
    const stillUnknown = importedRules.find((rule) => rule.name === 'Unknown site rule')
    assert.deepEqual(stillUnknown.sites, [unknownSiteId])
    assert.equal(result.unresolvedRuleSites.length, 1)
    assert.equal(result.unresolvedRuleSites[0]!.siteId, unknownSiteId)
    assert.equal(result.unresolvedRuleSites[0]!.groupId, ruleGroup!.id)
    assert.equal(result.unresolvedRuleSites[0]!.ruleName, 'Unknown site rule')

    // -> Access resolves against the restored page on the target site the same way it did against
    //    the source page (`sourceAccess`, captured above) — the whole point of the re-scoping.
    await groupsModel.reloadCache()
    const restoredAccess = groupsModel.checkAccess(actor, 'read:pages', {
      path: 'rule-scoped',
      locale: 'en',
      siteId: targetSiteId,
      classification: null
    })
    assert.equal(restoredAccess, sourceAccess)
  })
})
