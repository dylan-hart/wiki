import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { sites as sitesTable, tree as treeTable, users as usersTable } from '../db/schema.ts'
import { tree } from '../models/tree.ts'
import { users } from '../models/users.ts'
import type { SystemIds } from '../models/types.ts'
import { createAssetImportSummary, writeImportedAsset } from './assets.ts'
import { resolveAssetFolderPaths, type SourceAssetFolder } from './assetFolders.ts'

/**
 * Integration coverage for the `resolveAssetFolderPaths` -> `writeImportedAsset` handoff, run against
 * a throwaway Postgres exactly like `./assets.test.ts` (no live database reachable at localhost:5432
 * in this environment): schema + `ltree`/`pg_trgm` extensions + the real migrations. Separate
 * container/port from Task 747's own `wiki-test-db-747` so the two never collide.
 *
 * What this file exists to prove that a pure unit test on `resolveAssetFolderPaths` alone cannot:
 * that handing its resolved `folderPath` to `WIKI.models.tree.addAsset` (via `writeImportedAsset`)
 * genuinely reconstructs the whole 2.x `assetFolders` chain as 3.0 `tree` folder rows — nothing
 * pre-created — via `tree.ts`'s existing `getFolder({ createIfMissing: true })` ancestor-filling
 * (`tree.ts:761-814`), with each ancestor's `meta.children` landing correct.
 */

// -> Dedicated container/port for this task, distinct from Task 747's `wiki-test-db-747`.
const PORT = 55750

let pool: Pool
let db: ReturnType<typeof drizzle>
let siteId: string
let importedUserId: string
let systemIds: SystemIds

before(async () => {
  pool = new Pool({
    host: '127.0.0.1',
    port: PORT,
    user: 'postgres',
    password: 'postgres',
    database: 'postgres'
  })
  db = drizzle({ client: pool })

  await db.execute('CREATE EXTENSION IF NOT EXISTS ltree')
  await db.execute('CREATE EXTENSION IF NOT EXISTS pg_trgm')
  await migrate(db, {
    migrationsFolder: path.join(import.meta.dirname, '../db/migrations'),
    migrationsSchema: 'public',
    migrationsTable: 'migrations'
  })

  // -> Same minimal `WIKI` shape as `./assets.test.ts` — see that file's comment for why this subset
  //    is enough for everything `writeImportedAsset`/`resolveAssetFolderPaths` actually touch.
  ;(global as any).WIKI = {
    db,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    models: { tree, users },
    sites: {}
  }

  const insertedSite = await db
    .insert(sitesTable)
    .values({ hostname: 'test.local', isEnabled: true, config: { locales: { primary: 'en' } } })
    .returning()
  siteId = insertedSite[0].id
  ;(global as any).WIKI.sites[siteId] = { config: { locales: { primary: 'en' } } }

  const insertedUsers = await db
    .insert(usersTable)
    .values([{ email: 'admin@example.com', name: 'Administrator' }])
    .returning()
  const adminId = insertedUsers[0].id
  importedUserId = adminId
  systemIds = {
    groupAdminId: randomUUID(),
    groupUserId: randomUUID(),
    groupGuestId: randomUUID(),
    siteId,
    authModuleId: randomUUID(),
    userAdminId: adminId,
    userGuestId: randomUUID()
  }
})

after(async () => {
  await pool.end()
})

/** `tree.meta` is untyped `jsonb` at the schema level (see `db/schema.ts`); a folder's own shape
 *  (`{ children: number }`, per `tree.ts`'s `createFolder`/`countTowardsFolderAt`) is asserted here
 *  rather than widened generically, since only this test file cares about it. */
interface FolderTreeRow {
  meta: { children: number }
}

async function folderRow(folderPath: string, fileName: string): Promise<FolderTreeRow> {
  const [row] = await db
    .select()
    .from(treeTable)
    .where(
      and(
        eq(treeTable.siteId, siteId),
        eq(treeTable.folderPath, folderPath),
        eq(treeTable.fileName, fileName),
        eq(treeTable.type, 'folder')
      )
    )
  return row as unknown as FolderTreeRow
}

describe('resolveAssetFolderPaths + writeImportedAsset', () => {
  test('reconstructs the full 2.x assetFolders chain with no folders pre-created, correct meta.children throughout', async () => {
    // -> A 3-level-deep 2.x assetFolders chain: Documents (root) > 2024 > Q1 Report. Nothing under
    //    this site has been created yet — no folder rows at all.
    const sourceFolders: SourceAssetFolder[] = [
      { id: 1, name: 'Documents', slug: 'documents', parentId: null },
      { id: 2, name: '2024', slug: '2024', parentId: 1 },
      { id: 3, name: 'Q1 Report', slug: 'q1-report', parentId: 2 }
    ]
    const { paths, warnings } = resolveAssetFolderPaths(sourceFolders)
    assert.equal(warnings.length, 0)
    const leafPath = paths.get(3)!
    assert.equal(leafPath, 'documents/2024/q1-report')

    const summary = createAssetImportSummary()
    const asset = await writeImportedAsset(
      {
        sourceId: 'budget.pdf',
        filename: 'budget.pdf',
        ext: '.pdf',
        mime: 'application/pdf',
        fileSize: 10,
        data: Buffer.from('%PDF-fake'),
        folderPath: leafPath,
        authorId: importedUserId,
        siteId,
        createdAt: new Date('2018-01-01T00:00:00.000Z'),
        updatedAt: new Date('2018-01-01T00:00:00.000Z')
      },
      systemIds,
      summary,
      { makeThumbnail: async () => null }
    )
    assert.equal(asset.folderPath, leafPath)

    // -> Every intermediate folder must now exist, even though none were pre-created.
    const documents = await folderRow('', 'documents')
    const year = await folderRow('documents', '2024')
    const report = await folderRow('documents.2024', 'q1-report')
    assert.ok(documents, 'root "documents" folder was auto-created')
    assert.ok(year, '"2024" folder was auto-created under documents')
    assert.ok(report, '"q1-report" folder was auto-created under documents/2024')

    // -> One child each, the whole way down: documents has only "2024" in it, "2024" has only
    //    "q1-report", and "q1-report" has only the one imported asset.
    assert.equal(documents.meta.children, 1)
    assert.equal(year.meta.children, 1)
    assert.equal(report.meta.children, 1)

    const [treeRow] = await db.select().from(treeTable).where(eq(treeTable.id, asset.id))
    assert.equal(treeRow.folderPath, 'documents.2024.q1-report')
  })

  test('a second asset in an already-created sibling folder does not double-count an ancestor', async () => {
    const sourceFolders: SourceAssetFolder[] = [
      { id: 10, name: 'Archive', slug: 'archive', parentId: null },
      { id: 11, name: 'Alpha', slug: 'alpha', parentId: 10 },
      { id: 12, name: 'Beta', slug: 'beta', parentId: 10 }
    ]
    const { paths } = resolveAssetFolderPaths(sourceFolders)

    const summary = createAssetImportSummary()
    for (const [folderId, fileName] of [
      [11, 'alpha.txt'],
      [12, 'beta.txt']
    ] as const) {
      await writeImportedAsset(
        {
          sourceId: fileName,
          filename: fileName,
          ext: '.txt',
          mime: 'text/plain',
          fileSize: 1,
          data: Buffer.from('x'),
          folderPath: paths.get(folderId)!,
          authorId: importedUserId,
          siteId,
          createdAt: new Date('2018-01-01T00:00:00.000Z'),
          updatedAt: new Date('2018-01-01T00:00:00.000Z')
        },
        systemIds,
        summary,
        { makeThumbnail: async () => null }
      )
    }

    const archive = await folderRow('', 'archive')
    const alpha = await folderRow('archive', 'alpha')
    const beta = await folderRow('archive', 'beta')
    // -> "archive" has two children (alpha, beta folders); each of those has exactly the one asset
    //    written into it.
    assert.equal(archive.meta.children, 2)
    assert.equal(alpha.meta.children, 1)
    assert.equal(beta.meta.children, 1)
  })
})
