/**
 * The real round trip Epic #2437's replication feature is actually about: a "scheduled pull" is
 * ultimately just `models/replicationExport.ts#buildSnapshot()` (source side, WP #2489) feeding its
 * output straight into `models/replicationImport.ts#importSnapshot()` (target side, WP #2490) — this
 * suite is the one place that runs both, back to back, against real Postgres, and proves the wire
 * format one side writes is exactly what the other reads. Each model already has its own co-located
 * unit-level suite (`models/replicationExport.test.ts`, `models/replicationImport.db.test.ts`), the
 * same way `api/blocks.ts`/`controllers/blocks.ts` did before `blockUploadServing.test.ts` — this
 * file is that round trip, not a third copy of either side's own coverage.
 *
 * SCOPE NOTE (OpenProject #2493): Feature #2437's full "scheduled pull" also needs an admin settings
 * panel for the source URL/token/cron schedule (WP #2491) and the actual scheduler wiring that fetches
 * an archive from a REMOTE instance over HTTP on a cron trigger (WP #2492) — neither exists in any
 * branch as of this WP. There is therefore nothing yet to drive this round trip through a real HTTP
 * pull or a real cron firing. What IS fully built and testable is the wipe-and-mirror mechanism a
 * scheduled run will invoke once #2492 lands: hand `buildSnapshot()`'s own output straight to
 * `importSnapshot()`, exactly as a same-process pull would once #2492 exists to download it first.
 * That mechanism is what this suite verifies. Re-visit once #2492 lands: at that point this suite (or
 * a sibling next to `core/scheduler.ts`) should additionally cover the cron trigger itself.
 *
 * Two real "instances" are stood up as two independent, randomly-named schemas against the SAME
 * `DATABASE_URL` -- not `setupTestDb()` twice: that fixture keeps its schema/pool/`WIKI` handle in
 * module-level singletons (see its own doc comment — "one `setupTestDb()` for the whole file"), so a
 * second call would clobber the first's bookkeeping rather than run alongside it. This file instead
 * open-codes the same schema-per-run approach `test/db.ts#setupTestDb()` uses internally, reusing its
 * exported `createExtensionsSerialized()` for the race-free extension setup exactly as
 * `migration/phases/settings.integration.test.ts` and `core/config.test.ts` already do for their own
 * hand-rolled fixtures.
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

/** One end of the round trip: its own pool, schema name and drizzle handle. */
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

/** One of every record kind `buildSnapshot()`/`importSnapshot()` cover, wired together with valid
 *  foreign keys — deliberately distinct ids/values between `seedContent()` calls for "source" and
 *  "target" so the round trip can tell whose rows ended up where. */
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
      // -> Target's own pre-existing content, standing in for whatever staging held before the
      //    scheduled pull ran -- this is what proves the import genuinely WIPES rather than merges.
      targetContent = await seedContent(target.db, 'target')

      dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-replication-round-trip-'))
      // -> A single WIKI global is installed for the whole suite; each step below reassigns `.db`
      //    immediately before the call that needs it, rather than juggling two WIKI stubs. Nothing
      //    under test reads `WIKI.db` outside the two calls this suite makes.
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

      // -> Source side: build a real snapshot tarball off `source.db`.
      WIKI.db = source.db
      const exportResult = await replicationExport.buildSnapshot()
      assert.match(exportResult.filePath, /\.tar\.gz$/)
      const stat = await fs.stat(exportResult.filePath)
      assert.equal(stat.size, exportResult.fileSize)
      assert.ok(exportResult.fileSize > 0)

      // -> Target side: feed that exact file straight into the real importer against `target.db`,
      //    exactly as a same-process pull would once WP #2492 exists to have downloaded it first.
      WIKI.db = target.db
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

      // -> WIPED: none of target's own pre-existing rows survived the pull.
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
