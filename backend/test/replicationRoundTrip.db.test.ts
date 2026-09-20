/**
 * `models/replicationExport.ts` and `models/replicationImport.ts` each have their own co-located
 * unit-level suite; this file is the round trip between them, proving the wire format one side
 * writes is what the other reads.
 *
 * TODO: nothing can drive this through a real pull — the HTTP fetch from a remote instance and the
 * cron trigger a scheduled pull needs do not exist yet. Cover the trigger once it lands; meanwhile
 * the snapshot is fed in-process instead of over HTTP.
 *
 * Two "instances" are two independent, randomly-named schemas against the SAME `DATABASE_URL`, not
 * `setupTestDb()` twice: that fixture keeps its schema/pool/`CARDINAL` handle in module-level
 * singletons, so a second call would clobber the first's bookkeeping rather than run alongside it.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { sql } from 'drizzle-orm'
import { relations } from '../db/relations.ts'
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
import { createExtensionsSerialized, hasTestDatabase } from './db.ts'
import { installTestWiki } from './mocks.ts'
import { ensureTemporal } from './temporal.ts'
import type { WikiDb } from '../core/db.ts'

interface Instance {
  pool: Pool
  schema: string
  db: WikiDb
}

async function openInstance(): Promise<Instance> {
  const schema = `test_${randomBytes(6).toString('hex')}`
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    options: `-c search_path=${schema},public`
  })
  const db = drizzle({ client: pool, relations }) as WikiDb

  await db.execute(sql.raw(`CREATE SCHEMA "${schema}"`))
  await createExtensionsSerialized(pool)
  await migrate(db, {
    migrationsFolder: path.join(import.meta.dirname, '../db/migrations'),
    migrationsSchema: schema,
    migrationsTable: 'migrations'
  })

  return { pool, schema, db }
}

async function closeInstance(instance: Instance): Promise<void> {
  await instance.pool.query(`DROP SCHEMA IF EXISTS "${instance.schema}" CASCADE`)
  await instance.pool.end()
}

/** Every id and value is distinct between the "source" and "target" `seedContent()` calls, so the
 *  round trip can tell whose rows ended up where. */
interface SeededContent {
  siteId: string
  classificationId: string
  groupId: string
  userId: string
  navigationId: string
  pageId: string
  rootCommentId: string
  replyCommentId: string
  assetId: string
  assetData: Buffer
  assetPreview: Buffer
  settingKey: string
  settingValue: Record<string, unknown>
}

async function seedContent(db: WikiDb, label: string): Promise<SeededContent> {
  const [site] = await db
    .insert(sitesTable)
    .values({ hostname: `${label}.round-trip.localhost`, isEnabled: true, config: {} })
    .returning({ id: sitesTable.id })
  const siteId = site!.id

  const [classification] = await db
    .insert(classificationLevelsTable)
    .values({ name: `${label}-public`, sortOrder: 0 })
    .returning({ id: classificationLevelsTable.id })
  const classificationId = classification!.id

  const [group] = await db
    .insert(groupsTable)
    .values({ name: `${label}-group`, permissions: ['read:pages'], rules: [] })
    .returning({ id: groupsTable.id })
  const groupId = group!.id

  const [user] = await db
    .insert(usersTable)
    .values({
      email: `${label}@round-trip.example.com`,
      name: `${label} user`,
      isActive: true,
      isVerified: true
    })
    .returning({ id: usersTable.id })
  const userId = user!.id

  await db.insert(userGroupsTable).values({ userId, groupId })

  const [navigation] = await db
    .insert(navigationTable)
    .values({ siteId, mode: 'static', locale: null, items: [] })
    .returning({ id: navigationTable.id })
  const navigationId = navigation!.id

  const [page] = await db
    .insert(pagesTable)
    .values({
      locale: 'en',
      path: `${label}-welcome`,
      hash: `${label}-hash`,
      title: `${label} welcome`,
      editor: 'markdown',
      contentType: 'markdown',
      content: `# Hello from ${label}`,
      authorId: userId,
      creatorId: userId,
      ownerId: userId,
      siteId,
      classification: classificationId
    })
    .returning({ id: pagesTable.id })
  const pageId = page!.id

  await db.insert(treeTable).values({
    id: pageId,
    fileName: `${label}-welcome`,
    type: 'page',
    locale: 'en',
    title: `${label} welcome`,
    siteId,
    folderPath: ''
  })

  await db.insert(pageHistoryTable).values({
    pageId,
    locale: 'en',
    path: `${label}-welcome`,
    title: `${label} welcome`,
    content: `# Hello from ${label}`,
    siteId,
    authorId: userId
  })

  const [rootComment] = await db
    .insert(commentsTable)
    .values({ content: `${label} root comment`, pageId, siteId, authorId: userId, replyTo: null })
    .returning({ id: commentsTable.id })
  const rootCommentId = rootComment!.id

  const [replyComment] = await db
    .insert(commentsTable)
    .values({
      content: `${label} reply`,
      pageId,
      siteId,
      authorId: userId,
      replyTo: rootCommentId
    })
    .returning({ id: commentsTable.id })
  const replyCommentId = replyComment!.id

  const assetData = Buffer.from(`${label}-asset-bytes`)
  const assetPreview = Buffer.from(`${label}-asset-preview-bytes`)
  const [asset] = await db
    .insert(assetsTable)
    .values({
      fileName: `${label}.png`,
      fileExt: 'png',
      mimeType: 'image/png',
      fileSize: assetData.length,
      data: assetData,
      preview: assetPreview,
      authorId: userId,
      siteId
    })
    .returning({ id: assetsTable.id })
  const assetId = asset!.id

  const settingKey = `${label}RoundTripSetting`
  const settingValue = { source: label }
  await db.insert(settingsTable).values({ key: settingKey, value: settingValue })

  return {
    siteId,
    classificationId,
    groupId,
    userId,
    navigationId,
    pageId,
    rootCommentId,
    replyCommentId,
    assetId,
    assetData,
    assetPreview,
    settingKey,
    settingValue
  }
}

describe(
  'scheduled replication pull: buildSnapshot -> importSnapshot wipes and mirrors target from source (DB-backed)',
  { skip: !hasTestDatabase() },
  () => {
    let source: Instance
    let target: Instance
    let sourceContent: SeededContent
    let targetContent: SeededContent
    let dataPath: string
    let wikiHandle: { restore(): void }

    before(async () => {
      await ensureTemporal()

      source = await openInstance()
      target = await openInstance()
      sourceContent = await seedContent(source.db, 'source')
      // -> Target's own pre-existing content: what proves the import WIPES rather than merges.
      targetContent = await seedContent(target.db, 'target')

      dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-replication-round-trip-'))
      // -> One global for the whole suite, with `.db` reassigned right before each call: nothing
      //    under test reads `CARDINAL.db` elsewhere, so juggling two stubs would buy nothing.
      wikiHandle = installTestWiki({ db: source.db, config: { dataPath } })
    })

    after(async () => {
      wikiHandle.restore()
      await fs.rm(dataPath, { recursive: true, force: true })
      await closeInstance(source)
      await closeInstance(target)
    })

    test('a pull wipes the target instance and replaces it with an exact mirror of the source', async () => {
      const { replicationExport } = await import('../models/replicationExport.ts')
      const { replicationImportModel } = await import('../models/replicationImport.ts')

      CARDINAL.db = source.db
      const exportResult = await replicationExport.buildSnapshot()
      assert.match(exportResult.filePath, /\.tar\.gz$/)
      const stat = await fs.stat(exportResult.filePath)
      assert.equal(stat.size, exportResult.fileSize)
      assert.ok(exportResult.fileSize > 0)

      CARDINAL.db = target.db
      const report = await replicationImportModel.importSnapshot(exportResult.filePath)

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

      const allSites = await target.db.select().from(sitesTable)
      assert.equal(allSites.length, 1, 'target should hold exactly the one mirrored site')
      assert.equal(allSites[0]!.id, sourceContent.siteId)
      assert.equal(allSites[0]!.hostname, 'source.round-trip.localhost')
      assert.ok(
        !allSites.some((row) => row.id === targetContent.siteId),
        "target's own pre-existing site must be gone"
      )

      const allClassifications = await target.db.select().from(classificationLevelsTable)
      assert.equal(allClassifications.length, 1)
      assert.equal(allClassifications[0]!.id, sourceContent.classificationId)

      const allGroups = await target.db.select().from(groupsTable)
      assert.equal(allGroups.length, 1)
      assert.equal(allGroups[0]!.id, sourceContent.groupId)
      assert.equal(allGroups[0]!.name, 'source-group')

      const allUsers = await target.db.select().from(usersTable)
      assert.equal(allUsers.length, 1)
      assert.equal(allUsers[0]!.id, sourceContent.userId)
      assert.equal(allUsers[0]!.email, 'source@round-trip.example.com')

      const allUserGroups = await target.db.select().from(userGroupsTable)
      assert.equal(allUserGroups.length, 1)
      assert.equal(allUserGroups[0]!.userId, sourceContent.userId)
      assert.equal(allUserGroups[0]!.groupId, sourceContent.groupId)

      const allNavigation = await target.db.select().from(navigationTable)
      assert.equal(allNavigation.length, 1)
      assert.equal(allNavigation[0]!.id, sourceContent.navigationId)

      const allPages = await target.db.select().from(pagesTable)
      assert.equal(allPages.length, 1)
      assert.equal(allPages[0]!.id, sourceContent.pageId)
      assert.equal(allPages[0]!.content, '# Hello from source')

      const allTree = await target.db.select().from(treeTable)
      assert.equal(allTree.length, 1)
      assert.equal(allTree[0]!.id, sourceContent.pageId)

      const allHistory = await target.db.select().from(pageHistoryTable)
      assert.equal(allHistory.length, 1)
      assert.equal(allHistory[0]!.pageId, sourceContent.pageId)

      const allAssets = await target.db.select().from(assetsTable)
      assert.equal(allAssets.length, 1)
      assert.equal(allAssets[0]!.id, sourceContent.assetId)
      assert.equal(allAssets[0]!.data?.toString(), sourceContent.assetData.toString())
      assert.equal(allAssets[0]!.preview?.toString(), sourceContent.assetPreview.toString())

      const allComments = await target.db.select().from(commentsTable)
      assert.equal(allComments.length, 2)
      const root = allComments.find((c) => c.id === sourceContent.rootCommentId)
      const reply = allComments.find((c) => c.id === sourceContent.replyCommentId)
      assert.ok(root, 'the source root comment landed')
      assert.ok(reply, 'the source reply comment landed')
      assert.equal(root!.replyTo, null)
      assert.equal(reply!.replyTo, sourceContent.rootCommentId)
      assert.ok(
        !allComments.some((c) => c.id === targetContent.rootCommentId),
        "target's own pre-existing comments must be gone"
      )

      const allSettings = await target.db.select().from(settingsTable)
      const mirroredSetting = allSettings.find((s) => s.key === sourceContent.settingKey)
      assert.ok(mirroredSetting, 'the source setting landed')
      assert.deepEqual(mirroredSetting!.value, sourceContent.settingValue)
      assert.ok(
        !allSettings.some((s) => s.key === targetContent.settingKey),
        "target's own pre-existing setting must be gone"
      )
    })
  }
)
