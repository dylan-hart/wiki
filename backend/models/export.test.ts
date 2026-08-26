import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { list as listTarball } from 'tar'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import {
  assets as assetsTable,
  groups as groupsTable,
  pageHistory as pageHistoryTable,
  navigation as navigationTable
} from '../db/schema.ts'

/**
 * `exportSite` is almost entirely SQL orchestration (four tables' worth of site-scoped selects, plus
 * the site-wide groups) piped straight into a tar/gzip archive on disk, so a mock of the query builder
 * would mostly just be re-describing the code under test — same reasoning as `models/pages.test.ts`.
 * This suite runs it against a migrated, per-run-fresh database and reads the resulting tarball back.
 */
describe('export.exportSite (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let exportModel: typeof import('./export.ts').exportModel
  let pagesModel: typeof import('./pages.ts').pages
  let dataPath: string

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
    ;({ pages: pagesModel } = await import('./pages.ts'))

    dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-export-test-'))
    WIKI.config.dataPath = dataPath
  })

  after(async () => {
    await fs.rm(dataPath, { recursive: true, force: true })
    await teardownTestDb()
  })

  /** Reads every entry of a gzipped tar file back into a `{ name: Buffer }` map. */
  async function readTarball(filePath: string): Promise<Record<string, Buffer>> {
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

  test('exportSite writes a tarball with pages, tree, assets and groups', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'export-me',
        title: 'Export Me',
        editor: 'markdown',
        content: '# Hello export'
      },
      { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    )
    // -> createPage already recorded one `created` pageHistory row; this adds an `updated` one, so
    //    the export below has more than one revision to carry for the same page.
    await pagesModel.updatePage(
      fixtures.siteId,
      page.id,
      { content: '# Hello export, updated' },
      { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    )

    const assetData = Buffer.from('fake file bytes')
    const [asset] = await fixtures.db
      .insert(assetsTable)
      .values({
        fileName: 'test.txt',
        fileExt: 'txt',
        mimeType: 'text/plain',
        fileSize: assetData.length,
        data: assetData,
        authorId: fixtures.userId,
        siteId: fixtures.siteId
      })
      .returning({ id: assetsTable.id })

    const result = await exportModel.exportSite(fixtures.siteId)

    assert.match(result.filePath, /\.tar\.gz$/)
    assert.equal(path.dirname(result.filePath), path.join(dataPath, 'exports'))
    const stat = await fs.stat(result.filePath)
    assert.equal(stat.size, result.fileSize)
    assert.ok(result.fileSize > 0)

    const entries = await readTarball(result.filePath)

    const manifest = JSON.parse(entries['manifest.json']!.toString('utf8'))
    assert.equal(manifest.siteId, fixtures.siteId)

    const exportedPages = JSON.parse(entries['pages.json']!.toString('utf8'))
    assert.ok(exportedPages.some((p: any) => p.id === page.id && p.path === 'export-me'))
    // -> Regenerated columns must not have made it into the export
    assert.equal('ts' in exportedPages[0], false)

    const exportedPageHistory = JSON.parse(entries['pageHistory.json']!.toString('utf8'))
    const pageHistoryForPage = exportedPageHistory.filter((h: any) => h.pageId === page.id)
    assert.equal(pageHistoryForPage.length, 2)
    assert.ok(pageHistoryForPage.some((h: any) => h.action === 'created'))
    assert.ok(pageHistoryForPage.some((h: any) => h.action === 'updated'))

    const exportedGroups = JSON.parse(entries['groups.json']!.toString('utf8'))
    assert.ok(exportedGroups.some((g: any) => g.id === fixtures.groupId))

    const exportedHistory = JSON.parse(entries['pageHistory.json']!.toString('utf8'))
    assert.ok(Array.isArray(exportedHistory))

    const exportedNavigation = JSON.parse(entries['navigation.json']!.toString('utf8'))
    assert.ok(Array.isArray(exportedNavigation))

    const assetManifest = JSON.parse(entries['assets/manifest.json']!.toString('utf8'))
    const exportedAsset = assetManifest.find((a: any) => a.id === asset!.id)
    assert.ok(exportedAsset)
    // -> The bytes travel as their own archive entry, not inlined into the JSON manifest
    assert.equal('data' in exportedAsset, false)
    assert.deepEqual(entries[`assets/${asset!.id}.data`], assetData)
  })

  test('exportSite includes page history and navigation rows', async () => {
    const page = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'history-me',
        title: 'History Me',
        editor: 'markdown',
        content: '# v1'
      },
      { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    )

    const [historyRow] = await fixtures.db
      .insert(pageHistoryTable)
      .values({
        pageId: page.id,
        action: 'updated',
        locale: 'en',
        path: 'history-me',
        title: 'History Me',
        content: '# v1',
        siteId: fixtures.siteId,
        authorId: fixtures.userId
      })
      .returning({ id: pageHistoryTable.id })

    // -> `createPage` above already triggers `navigation.ts#ensureSiteNav`, which seeds a blank
    //    default menu for this site's primary locale -- upserted rather than inserted so this doesn't
    //    collide with that row's own (siteId, locale) uniqueness constraint.
    const [navRow] = await fixtures.db
      .insert(navigationTable)
      .values({
        items: [{ id: 'a', type: 'link', label: 'Home', target: '/' }],
        mode: 'static',
        locale: 'en',
        siteId: fixtures.siteId
      })
      .onConflictDoUpdate({
        target: [navigationTable.siteId, navigationTable.locale],
        set: { items: [{ id: 'a', type: 'link', label: 'Home', target: '/' }] }
      })
      .returning({ id: navigationTable.id })

    const result = await exportModel.exportSite(fixtures.siteId)
    const entries = await readTarball(result.filePath)

    const exportedHistory = JSON.parse(entries['pageHistory.json']!.toString('utf8'))
    assert.ok(exportedHistory.some((h: any) => h.id === historyRow!.id && h.pageId === page.id))

    const exportedNavigation = JSON.parse(entries['navigation.json']!.toString('utf8'))
    assert.ok(exportedNavigation.some((n: any) => n.id === navRow!.id && n.locale === 'en'))
  })

  test('exportSite excludes isSystem groups (Administrators/Users/Guests)', async () => {
    const [systemGroup] = await fixtures.db
      .insert(groupsTable)
      .values({
        name: 'Administrators',
        permissions: ['manage:system'],
        rules: [],
        isSystem: true
      })
      .returning({ id: groupsTable.id })

    const result = await exportModel.exportSite(fixtures.siteId)
    const entries = await readTarball(result.filePath)

    const exportedGroups = JSON.parse(entries['groups.json']!.toString('utf8'))

    // -> The seeded, non-system fixture group still makes it through...
    assert.ok(exportedGroups.some((g: any) => g.id === fixtures.groupId))
    // -> ...but the isSystem row does not: `importSite` upserts groups by id, and restoring an
    //    isSystem row onto a different instance overwrites that instance's own Administrators/
    //    Users/Guests (see the comment on `exportSite`'s group select).
    assert.ok(!exportedGroups.some((g: any) => g.id === systemGroup!.id))
  })

  test('exportSite rejects an unknown site', async () => {
    await assert.rejects(
      exportModel.exportSite('00000000-0000-0000-0000-000000000000'),
      /does not exist/
    )
  })

  test('purgeExpired removes nothing when everything is fresh', async () => {
    const result = await exportModel.exportSite(fixtures.siteId)
    const purged = await exportModel.purgeExpired()
    assert.equal(purged, 0)
    await fs.access(result.filePath)
  })

  test('deleteExport removes the file and tolerates being called twice', async () => {
    const result = await exportModel.exportSite(fixtures.siteId)
    await exportModel.deleteExport(result.filePath)
    await assert.rejects(fs.access(result.filePath))
    // -> Idempotent: a second delete of an already-gone file must not throw
    await exportModel.deleteExport(result.filePath)
  })
})
