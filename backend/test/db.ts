/**
 * DB-backed test fixture. Gate the whole `describe` on `hasTestDatabase()` — an unset `DATABASE_URL`
 * must report as skipped, not fail — and call `setupTestDb()`/`teardownTestDb()` from
 * `before()`/`after()`.
 */
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { asc, sql } from 'drizzle-orm'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { relations } from '../db/relations.ts'
import {
  classificationLevels as classificationLevelsTable,
  groups as groupsTable,
  locales as localesTable,
  sites as sitesTable,
  tree as treeTable,
  users as usersTable
} from '../db/schema.ts'
import type { SiteRow } from '../db/schema.ts'
import { encodeTreePath } from '../helpers/common.ts'
import type { WikiDb } from '../core/db.ts'
import type { NavigationMode } from '../models/navigation.ts'
import { installTestWiki } from './mocks.ts'

/** Mirrors `core/db.ts` — migration SQL depends on each, so keep the two lists in step. */
const REQUIRED_EXTENSIONS = ['ltree', 'pg_trgm', 'pgcrypto']

export interface TestFixtures {
  db: WikiDb
  siteId: string
  userId: string
  groupId: string
  /** The most open seeded level — `pages.classification` is `NOT NULL`, so every insert needs one. */
  classificationId: string
  /** A worker thread standing up its own `CARDINAL` points its pool's `search_path` here, or it
   *  sees an empty `public` instead of this run's tables. */
  schema: string
}

export function hasTestDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL)
}

let pool: Pool | null = null
let currentSchema: string | null = null
/** Held so teardown puts back whatever `globalThis.CARDINAL` was: `node --test` isolates files, not
 *  suites within a file, so this fixture's stub would otherwise outlive it. */
let wikiHandle: { restore(): void } | null = null

/**
 * Each call gets its own randomly-named schema rather than reusing a fixed one: `node --test` runs
 * matched files concurrently and every DB-backed suite points at the same `DATABASE_URL`, so a
 * shared schema would mean two suites' `CREATE SCHEMA`/`DROP SCHEMA` racing each other.
 */
export async function setupTestDb(): Promise<TestFixtures> {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'setupTestDb() called without DATABASE_URL set — gate the suite on hasTestDatabase() instead.'
    )
  }

  const schema = `test_${randomBytes(6).toString('hex')}`
  // -> `public` stays on the search path behind the test schema: an extension is a per-database
  //    object, so whichever suite creates `ltree` first owns it and every other schema still has to
  //    see it or its migration fails on a type it does not consider itself to have.
  pool = new Pool({
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
  currentSchema = schema

  const models = (await import('../models/index.ts')).default
  installDbTestWiki(db, models)

  const [site] = await db
    .insert(sitesTable)
    .values({
      hostname: 'test.localhost',
      isEnabled: true,
      config: { locales: { primary: 'en', active: ['en', 'fr'] } }
    })
    .returning()

  const [user] = await db
    .insert(usersTable)
    .values({
      email: 'fixture@example.com',
      name: 'Fixture User',
      isActive: true,
      isVerified: true
    })
    .returning({ id: usersTable.id })

  const [group] = await db
    .insert(groupsTable)
    .values({
      name: 'Fixture Group',
      permissions: ['read:pages'],
      rules: []
    })
    .returning({ id: groupsTable.id })

  // -> Migrating a fresh schema seeds no rows, so these stand in for what a real boot's
  //    `models.classificationLevels.init()` would insert — same three levels at the same fixed ids
  //    `base.yml`'s `systemIds` declares.
  await db.insert(classificationLevelsTable).values([
    { id: '30000000-0000-4000-8000-000000000001', name: 'Public', sortOrder: 0 },
    { id: '30000000-0000-4000-8000-000000000002', name: 'Internal', sortOrder: 1 },
    { id: '30000000-0000-4000-8000-000000000003', name: 'Restricted', sortOrder: 2 }
  ])
  const [classification] = await db
    .select({ id: classificationLevelsTable.id })
    .from(classificationLevelsTable)
    .orderBy(asc(classificationLevelsTable.sortOrder))
    .limit(1)
  // -> `defaultLevel()` reads the in-memory cache, not the db, so without this a `createPage()` or
  //    `movePage()` sees an empty level list and fails its guard.
  await models.classificationLevels.reloadCache()

  // -> `config` reads back as `unknown` (no `$type<>` pin on the jsonb column); the cast matches the
  //    one `models/sites.ts#reloadCache()` applies to the same shape in production.
  CARDINAL.sites[site!.id] = site! as SiteRow

  return {
    db,
    siteId: site!.id,
    userId: user!.id,
    groupId: group!.id,
    classificationId: classification!.id,
    schema
  }
}

/**
 * An advisory lock, not just `IF NOT EXISTS`: postgres's existence check for `CREATE EXTENSION IF
 * NOT EXISTS` is not atomic against another session doing the same thing, so two suites racing to
 * create `ltree` for the first time hit a duplicate-key error on `pg_extension` despite the guard.
 * Lock and unlock must run on the same physical connection — a `Pool` query checks one out and back
 * in per call — hence the dedicated client rather than `db.execute()`.
 */
export async function createExtensionsSerialized(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('wiki_test_extensions'))`)
    try {
      for (const extension of REQUIRED_EXTENSIONS) {
        await client.query(`CREATE EXTENSION IF NOT EXISTS ${extension} SCHEMA public`)
      }
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext('wiki_test_extensions'))`)
    }
  } finally {
    client.release()
  }
}

export interface SeedTreeEntryInput {
  siteId: string
  /** Full path, e.g. `'docs/child'`. Pass `folderPath`/`fileName` instead for anything
   *  `encodeTreePath` can't express. */
  path?: string
  folderPath?: string
  fileName?: string
  type?: 'folder' | 'page' | 'asset'
  locale?: string
  title?: string
  navigationMode?: NavigationMode
  navigationId?: string | null
  tags?: string[]
  meta?: Record<string, unknown>
}

/**
 * Bypasses `models/pages.ts#createPage`'s write path, which also touches `pages`/`pageHistory` a
 * tree-only test has no use for.
 */
export async function seedTreeEntry(db: WikiDb, input: SeedTreeEntryInput) {
  const encoded = input.path !== undefined ? encodeTreePath(input.path) : undefined
  const parts = encoded ? encoded.split('.') : []
  const folderPath = input.folderPath ?? (parts.length > 1 ? parts.slice(0, -1).join('.') : '')
  const fileName = input.fileName ?? parts.at(-1) ?? ''

  const [entry] = await db
    .insert(treeTable)
    .values({
      siteId: input.siteId,
      folderPath,
      fileName,
      type: input.type ?? 'page',
      locale: input.locale ?? 'en',
      title: input.title ?? fileName,
      navigationMode: input.navigationMode ?? 'inherit',
      navigationId: input.navigationId ?? null,
      tags: input.tags ?? [],
      meta: input.meta ?? {}
    })
    .returning()

  return entry!
}

/**
 * Call from `after()`: the drop keeps a long-lived shared instance from accumulating one abandoned
 * schema per run, and closing the pool is what lets the process exit instead of hanging on a socket.
 */
export async function teardownTestDb(): Promise<void> {
  if (pool && currentSchema) {
    await pool.query(`DROP SCHEMA IF EXISTS "${currentSchema}" CASCADE`)
  }
  await pool?.end()
  pool = null
  currentSchema = null
  wikiHandle?.restore()
  wikiHandle = null
}

export interface SeedLocaleInput {
  code: string
  name?: string
  nativeName?: string
  region?: string
  script?: string
  isRTL?: boolean
}

/**
 * The `locales` table starts empty on a fresh schema, but `models/locales.ts#getLocales()` (and so
 * `isReservedLocaleCode()`) reads through it — a suite asserting on locale codes has to install
 * them first. `code` is split on its first `-` into `language`/`region`; pass `region`/`script`
 * directly for anything that split can't express.
 */
export async function seedLocale(db: WikiDb, input: SeedLocaleInput) {
  const [language, region] = input.code.split('-')
  const [row] = await db
    .insert(localesTable)
    .values({
      code: input.code,
      name: input.name ?? input.code,
      nativeName: input.nativeName ?? input.code,
      language: language!,
      region: input.region ?? region ?? '',
      script: input.script ?? '',
      isRTL: input.isRTL ?? false
    })
    .returning()
  return row!
}

/**
 * Deliberately not `index.ts`'s boot sequence: that also starts the HTTP server, the scheduler's
 * thread pool and the postgres LISTEN/NOTIFY subscription, none of which model-layer logic touches
 * and any one of which can hang or flake a test for a cause unrelated to the code under test.
 */
function installDbTestWiki(db: WikiDb, models: typeof import('../models/index.ts').default): void {
  // -> Puppeteer is never installed in this test environment, so the real `ensureCanRender()` would
  //    refuse every `createPage()`/`updatePage()` call. A suite that does care about rendering
  //    re-wraps this with `mock.method()`.
  models.renderQueue.ensureCanRender = async () => {}
  wikiHandle = installTestWiki({
    db,
    // -> `helpers/advisoryLock.ts#getLockPool()` builds its lock pool from `CARDINAL.dbManager.config`,
    //    so a suite exercising the real `withAdvisoryLock` crashes reading `.config` off `undefined`
    //    without this. Only `connectionString` — nothing DB-backed reaches the other members.
    dbManager: { config: { connectionString: process.env.DATABASE_URL } },
    models
  })
}
