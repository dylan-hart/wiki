import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { create as createTarball } from 'tar'
import { eq } from 'drizzle-orm'
import { hasTestDatabase, setupTestDb, teardownTestDb, type TestFixtures } from '../test/db.ts'
import { ensureTemporal } from '../test/temporal.ts'
import {
  assets as assetsTable,
  classificationLevels as classificationLevelsTable,
  comments as commentsTable,
  groups as groupsTable,
  navigation as navigationTable,
  pageHistory as pageHistoryTable,
  pages as pagesTable,
  settings as settingsTable,
  sites as sitesTable,
  tree as treeTable,
  userGroups as userGroupsTable,
  users as usersTable
} from '../db/schema.ts'

/** Stages a `{ name: Buffer }` map to real files under a throwaway dir, then tars it into a fresh
 *  archive at `filePath` — same approach `models/siteImport.test.ts#buildArchive` uses, since `tar`'s
 *  `Pack` only ever archives real files. */
async function buildArchive(filePath: string, entries: Record<string, Buffer>): Promise<void> {
  const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-replication-import-build-'))
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

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value))
}

describe('replicationImportModel.importSnapshot (DB-backed)', { skip: !hasTestDatabase() }, () => {
  let fixtures: TestFixtures
  let importSnapshot: typeof import('./replicationImport.ts').replicationImportModel.importSnapshot
  let tmpDir: string

  before(async () => {
    await ensureTemporal()
    fixtures = await setupTestDb()
    ;({
      replicationImportModel: { importSnapshot }
    } = await import('./replicationImport.ts'))
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-replication-import-test-'))
  })

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
    await teardownTestDb()
  })

  test('a version mismatch is refused before anything on the instance is touched', async () => {
    const filePath = path.join(tmpDir, `${crypto.randomUUID()}.tar.gz`)
    await buildArchive(filePath, {
      'manifest.json': json({ formatVersion: 999 })
    })

    await assert.rejects(importSnapshot(filePath), /Unsupported replication archive version/)

    // -> Nothing was wiped: the fixture site `setupTestDb()` seeded is still exactly there.
    const stillThere = await fixtures.db
      .select({ id: sitesTable.id })
      .from(sitesTable)
      .where(eq(sitesTable.id, fixtures.siteId))
    assert.equal(stillThere.length, 1)
  })

  test('wipes the instance and replaces it with the snapshot, ids preserved, comments ordered by reply depth', async () => {
    const siteId = crypto.randomUUID()
    const classificationId = crypto.randomUUID()
    const groupId = crypto.randomUUID()
    const userId = crypto.randomUUID()
    const navigationId = crypto.randomUUID()
    const pageId = crypto.randomUUID()
    const assetId = crypto.randomUUID()
    const rootCommentId = crypto.randomUUID()
    const replyCommentId = crypto.randomUUID()

    const assetData = Buffer.from('fake-image-bytes')
    const assetPreview = Buffer.from('fake-preview-bytes')

    const filePath = path.join(tmpDir, `${crypto.randomUUID()}.tar.gz`)
    await buildArchive(filePath, {
      'manifest.json': json({ formatVersion: 1, generatedAt: new Date().toISOString() }),
      'sites.json': json([
        { id: siteId, hostname: 'replicated.localhost', isEnabled: true, config: {} }
      ]),
      'classificationLevels.json': json([{ id: classificationId, name: 'Public', sortOrder: 0 }]),
      'groups.json': json([
        { id: groupId, name: 'Restored Group', permissions: ['read:pages'], rules: [] }
      ]),
      'users.json': json([
        { id: userId, email: 'restored@example.com', name: 'Restored User', isActive: true }
      ]),
      'userGroups.json': json([{ userId, groupId }]),
      'navigation.json': json([
        { id: navigationId, siteId, mode: 'static', locale: null, items: [] }
      ]),
      'tree.json': json([
        {
          id: pageId,
          fileName: 'welcome',
          type: 'page',
          locale: 'en',
          title: 'Welcome',
          siteId,
          folderPath: ''
        }
      ]),
      'pages.json': json([
        {
          id: pageId,
          locale: 'en',
          path: 'welcome',
          hash: 'somehash',
          title: 'Welcome',
          editor: 'markdown',
          contentType: 'markdown',
          content: '# Hello replication',
          authorId: userId,
          creatorId: userId,
          ownerId: userId,
          siteId,
          classification: classificationId
        }
      ]),
      'pageHistory.json': json([
        {
          id: crypto.randomUUID(),
          pageId,
          locale: 'en',
          path: 'welcome',
          title: 'Welcome',
          content: '# Hello replication',
          siteId,
          authorId: userId
        }
      ]),
      'comments.json': json([
        // -> Deliberately listed reply-first, to prove `orderCommentsByReplyDepth` is actually wired
        //    into the restore rather than only unit-tested in isolation.
        {
          id: replyCommentId,
          content: 'A reply',
          pageId,
          siteId,
          authorId: userId,
          replyTo: rootCommentId
        },
        {
          id: rootCommentId,
          content: 'A root comment',
          pageId,
          siteId,
          authorId: userId,
          replyTo: null
        }
      ]),
      'assets/manifest.json': json([
        {
          id: assetId,
          fileName: 'logo.png',
          fileExt: 'png',
          authorId: userId,
          siteId
        }
      ]),
      [`assets/${assetId}.data`]: assetData,
      [`assets/${assetId}.preview`]: assetPreview,
      'settings.json': json([{ key: 'testReplicationSetting', value: { flag: true } }])
    })

    const report = await importSnapshot(filePath)

    assert.deepEqual(report, {
      sites: 1,
      classificationLevels: 1,
      groups: 1,
      users: 1,
      userGroups: 1,
      navigation: 1,
      tree: 1,
      pages: 1,
      pageHistory: 1,
      assets: 1,
      comments: 2,
      settings: 1
    })

    // -> The fixture's own pre-existing rows are gone — wiped, not merged with.
    const oldSite = await fixtures.db
      .select({ id: sitesTable.id })
      .from(sitesTable)
      .where(eq(sitesTable.id, fixtures.siteId))
    assert.equal(oldSite.length, 0)
    const oldClassifications = await fixtures.db.select().from(classificationLevelsTable)
    assert.equal(oldClassifications.length, 1)
    assert.equal(oldClassifications[0]!.id, classificationId)

    // -> The archive's own rows landed, ids preserved exactly (no remapping).
    const [restoredSite] = await fixtures.db
      .select()
      .from(sitesTable)
      .where(eq(sitesTable.id, siteId))
    assert.equal(restoredSite!.hostname, 'replicated.localhost')

    const [restoredGroup] = await fixtures.db
      .select()
      .from(groupsTable)
      .where(eq(groupsTable.id, groupId))
    assert.equal(restoredGroup!.name, 'Restored Group')

    const restoredUserGroups = await fixtures.db
      .select()
      .from(userGroupsTable)
      .where(eq(userGroupsTable.userId, userId))
    assert.equal(restoredUserGroups.length, 1)
    assert.equal(restoredUserGroups[0]!.groupId, groupId)

    const [restoredNavigation] = await fixtures.db
      .select()
      .from(navigationTable)
      .where(eq(navigationTable.id, navigationId))
    assert.equal(restoredNavigation!.siteId, siteId)

    const [restoredPage] = await fixtures.db
      .select()
      .from(pagesTable)
      .where(eq(pagesTable.id, pageId))
    assert.equal(restoredPage!.content, '# Hello replication')
    assert.equal(restoredPage!.classification, classificationId)

    const [restoredTree] = await fixtures.db
      .select()
      .from(treeTable)
      .where(eq(treeTable.id, pageId))
    assert.equal(restoredTree!.fileName, 'welcome')

    const restoredHistory = await fixtures.db
      .select()
      .from(pageHistoryTable)
      .where(eq(pageHistoryTable.pageId, pageId))
    assert.equal(restoredHistory.length, 1)

    const [restoredAsset] = await fixtures.db
      .select()
      .from(assetsTable)
      .where(eq(assetsTable.id, assetId))
    assert.equal(restoredAsset!.data?.toString(), assetData.toString())
    assert.equal(restoredAsset!.preview?.toString(), assetPreview.toString())

    const restoredComments = await fixtures.db
      .select()
      .from(commentsTable)
      .where(eq(commentsTable.pageId, pageId))
    assert.equal(restoredComments.length, 2)
    const root = restoredComments.find((c) => c.id === rootCommentId)
    const reply = restoredComments.find((c) => c.id === replyCommentId)
    assert.equal(root!.replyTo, null)
    assert.equal(reply!.replyTo, rootCommentId)

    const [restoredSetting] = await fixtures.db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.key, 'testReplicationSetting'))
    assert.deepEqual(restoredSetting!.value, { flag: true })

    const [restoredUser] = await fixtures.db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId))
    assert.equal(restoredUser!.email, 'restored@example.com')
  })
})
