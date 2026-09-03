import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { list as listTarball } from 'tar'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { ensureTemporal } from '../test/temporal.ts'
import {
  assets as assetsTable,
  comments as commentsTable,
  groups as groupsTable,
  navigation as navigationTable,
  settings as settingsTable,
  sites as sitesTable
} from '../db/schema.ts'

/**
 * `buildSnapshot` is almost entirely SQL orchestration (every table in Feature #2437's full-parity
 * scope, unfiltered by site) piped straight into a tar/gzip archive on disk, so a mock of the query
 * builder would mostly just be re-describing the code under test -- same reasoning as
 * `models/export.test.ts`. This suite runs it against a migrated, per-run-fresh database and reads
 * the resulting tarball back, seeding a SECOND site to prove the snapshot really is instance-wide and
 * not accidentally scoped to `fixtures.siteId` alone.
 */
describe('replicationExport.buildSnapshot (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let replicationExportModel: typeof import('./replicationExport.ts').replicationExport
  let pagesModel: typeof import('./pages.ts').pages
  let dataPath: string
  let secondSiteId: string

  before(async () => {
    await ensureTemporal()

    fixtures = await setupTestDb()
    ;({ replicationExport: replicationExportModel } = await import('./replicationExport.ts'))
    ;({ pages: pagesModel } = await import('./pages.ts'))

    dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-replication-export-test-'))
    WIKI.config.dataPath = dataPath

    const [secondSite] = await fixtures.db
      .insert(sitesTable)
      .values({
        hostname: 'second.test.localhost',
        isEnabled: true,
        config: { locales: { primary: 'en', active: ['en'] } }
      })
      .returning({ id: sitesTable.id })
    secondSiteId = secondSite!.id
    // -> `pages.ts#createPage` checks the in-memory `WIKI.sites` cache, not the DB row directly --
    //    `setupTestDb()` already registers the fixture site there; this second one needs the same
    //    registration or `createPage(secondSiteId, ...)` below 404s as an unknown site.
    WIKI.sites[secondSiteId] = {
      id: secondSiteId,
      config: { locales: { primary: 'en', active: ['en'] } }
    }
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

  test('buildSnapshot writes a tarball covering every site, not just one', async () => {
    const pageOnSiteOne = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'export-me-1',
        title: 'Export Me One',
        editor: 'markdown',
        content: '# Hello site one'
      },
      { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    )
    const pageOnSiteTwo = await pagesModel.createPage(
      secondSiteId,
      {
        path: 'export-me-2',
        title: 'Export Me Two',
        editor: 'markdown',
        content: '# Hello site two'
      },
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
        siteId: secondSiteId
      })
      .returning({ id: assetsTable.id })

    const result = await replicationExportModel.buildSnapshot()

    assert.match(result.filePath, /\.tar\.gz$/)
    assert.equal(path.dirname(result.filePath), path.join(dataPath, 'exports'))
    const stat = await fs.stat(result.filePath)
    assert.equal(stat.size, result.fileSize)
    assert.ok(result.fileSize > 0)

    const entries = await readTarball(result.filePath)

    const manifest = JSON.parse(entries['manifest.json']!.toString('utf8'))
    assert.equal(manifest.formatVersion, 1)
    assert.equal(manifest.siteCount, 2)

    const exportedSites = JSON.parse(entries['sites.json']!.toString('utf8'))
    assert.ok(exportedSites.some((s: any) => s.id === fixtures.siteId))
    assert.ok(exportedSites.some((s: any) => s.id === secondSiteId))

    const exportedPages = JSON.parse(entries['pages.json']!.toString('utf8'))
    assert.ok(exportedPages.some((p: any) => p.id === pageOnSiteOne.id))
    assert.ok(exportedPages.some((p: any) => p.id === pageOnSiteTwo.id))
    // -> Regenerated columns must not have made it into the export
    assert.equal('ts' in exportedPages[0], false)
    assert.equal('searchContent' in exportedPages[0], false)

    const exportedPageHistory = JSON.parse(entries['pageHistory.json']!.toString('utf8'))
    assert.ok(exportedPageHistory.some((h: any) => h.pageId === pageOnSiteOne.id))
    assert.ok(exportedPageHistory.some((h: any) => h.pageId === pageOnSiteTwo.id))

    const exportedUsers = JSON.parse(entries['users.json']!.toString('utf8'))
    assert.ok(exportedUsers.some((u: any) => u.id === fixtures.userId))

    const exportedClassificationLevels = JSON.parse(
      entries['classificationLevels.json']!.toString('utf8')
    )
    assert.ok(exportedClassificationLevels.some((c: any) => c.id === fixtures.classificationId))

    const assetManifest = JSON.parse(entries['assets/manifest.json']!.toString('utf8'))
    const exportedAsset = assetManifest.find((a: any) => a.id === asset!.id)
    assert.ok(exportedAsset)
    // -> The bytes travel as their own archive entry, not inlined into the JSON manifest
    assert.equal('data' in exportedAsset, false)
    assert.deepEqual(entries[`assets/${asset!.id}.data`], assetData)
  })

  test('buildSnapshot includes isSystem groups, unlike the per-site exportSite', async () => {
    const [systemGroup] = await fixtures.db
      .insert(groupsTable)
      .values({
        name: 'Administrators',
        permissions: ['manage:system'],
        rules: [],
        isSystem: true
      })
      .returning({ id: groupsTable.id })

    const result = await replicationExportModel.buildSnapshot()
    const entries = await readTarball(result.filePath)

    const exportedGroups = JSON.parse(entries['groups.json']!.toString('utf8'))

    // -> The seeded, non-system fixture group still makes it through...
    assert.ok(exportedGroups.some((g: any) => g.id === fixtures.groupId))
    // -> ...and, unlike `exportSite`, so does the isSystem row: a whole-instance wipe-and-replace has
    //    nothing on the target already seeded to collide with.
    assert.ok(exportedGroups.some((g: any) => g.id === systemGroup!.id))
  })

  test('buildSnapshot includes settings, navigation and comments across the instance', async () => {
    await fixtures.db
      .insert(settingsTable)
      .values({ key: 'test.setting', value: { v: 'hello' } })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: { v: 'hello' } } })

    const page = await pagesModel.createPage(
      fixtures.siteId,
      {
        path: 'commented-page',
        title: 'Commented Page',
        editor: 'markdown',
        content: '# has comments'
      },
      { id: fixtures.userId, permissions: ['manage:system'], groupIds: [] }
    )
    const [comment] = await fixtures.db
      .insert(commentsTable)
      .values({
        content: 'A comment',
        pageId: page.id,
        siteId: fixtures.siteId,
        authorId: fixtures.userId
      })
      .returning({ id: commentsTable.id })

    const [navRow] = await fixtures.db
      .insert(navigationTable)
      .values({
        items: [{ id: 'a', type: 'link', label: 'Home', target: '/' }],
        mode: 'static',
        locale: 'en',
        siteId: secondSiteId
      })
      .onConflictDoUpdate({
        target: [navigationTable.siteId, navigationTable.locale],
        set: { items: [{ id: 'a', type: 'link', label: 'Home', target: '/' }] }
      })
      .returning({ id: navigationTable.id })

    const result = await replicationExportModel.buildSnapshot()
    const entries = await readTarball(result.filePath)

    const exportedSettings = JSON.parse(entries['settings.json']!.toString('utf8'))
    assert.ok(exportedSettings.some((s: any) => s.key === 'test.setting'))

    const exportedComments = JSON.parse(entries['comments.json']!.toString('utf8'))
    assert.ok(exportedComments.some((c: any) => c.id === comment!.id))

    const exportedNavigation = JSON.parse(entries['navigation.json']!.toString('utf8'))
    assert.ok(exportedNavigation.some((n: any) => n.id === navRow!.id && n.siteId === secondSiteId))
  })

  test('purgeExpired removes nothing when everything is fresh', async () => {
    const result = await replicationExportModel.buildSnapshot()
    const purged = await replicationExportModel.purgeExpired()
    assert.equal(purged, 0)
    await fs.access(result.filePath)
  })

  test('deleteExport removes the file and tolerates being called twice', async () => {
    const result = await replicationExportModel.buildSnapshot()
    await replicationExportModel.deleteExport(result.filePath)
    await assert.rejects(fs.access(result.filePath))
    // -> Idempotent: a second delete of an already-gone file must not throw
    await replicationExportModel.deleteExport(result.filePath)
  })
})
