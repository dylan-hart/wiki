/**
 * DB-backed test fixture: setup/teardown for model tests that need a real Postgres connection.
 *
 * Gated on `DATABASE_URL` exactly like the rare DB-backed `helpers/` test — see "Testing (backend)"
 * in CLAUDE.md. A suite that needs this calls `hasTestDatabase()` in its own gate (skip the whole
 * `describe` when false) and `setupTestDb()` / `teardownTestDb()` in `before()`/`after()`.
 *
 * `setupTestDb()` creates a fresh, randomly-named schema and migrates into it, so a run never inherits
 * rows a previous run — or a concurrently-running suite's own setup — left behind; `teardownTestDb()`
 * drops it again. The fixture is disposable by construction rather than by remembering to clean up
 * afterwards, which is what makes it safe to point at either a throwaway container or a schema carved
 * out of a long-lived instance (e.g. `.devcontainer/docker-compose.yml`'s postgres). It then seeds
 * exactly the fixture `models/pages.ts`/`groups.ts`/`users.ts` tests need to exist before anything
 * else runs: one site, one user, one group — matching how a fresh Cardinal.js installation seeds itself
 * (`core/config.ts#initDbValues`), just without the rest of that sequence (no default admin/guest
 * accounts, no settings rows) that these tests have no use for. `seedTreeEntry()` seeds additional
 * `tree` rows (pages/folders/assets) on top of that base fixture, for suites — `models/navigation.ts`
 * is the first — that need entries in the tree beyond what `setupTestDb()` provides.
 *
 * Installs a minimal `WIKI` global alongside it — `db`, a quiet `logger`, `sites`, `config`, `models`,
 * plus the `cache`/`events`/`scheduler` stubs from `./mocks.ts`. Safe to do once per test file: `node --test`
 * isolates each matched file into its own process by default, so this global does not leak into any
 * other file's run.
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
import { encodeTreePath } from '../helpers/common.ts'
import type { WikiDb } from '../core/db.ts'
import type { NavigationMode } from '../models/navigation.ts'
import { installTestWiki } from './mocks.ts'

/** Same list `core/db.ts` installs before migrating — some migration's SQL depends on each. */
const REQUIRED_EXTENSIONS = ['ltree', 'pg_trgm', 'pgcrypto']

export interface TestFixtures {
  db: WikiDb
  siteId: string
  userId: string
  groupId: string
  /** A seeded classification level's id — every `pages.classification` insert needs one (the column
   *  is `NOT NULL`), and this is the fixture's "most open" default, matching what a fresh install's
   *  own seeding (`models/classificationLevels.ts#init`) would call `Public`. */
  classificationId: string
  /** The schema this run's tables live in — a worker thread standing up its own `WIKI` needs this to
   *  point its own pool's `search_path` at the same tables rather than an empty `public`. */
  schema: string
}

/** Whether a DB-backed suite may run at all. Gate every such `describe` on this. */
export function hasTestDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL)
}

let pool: Pool | null = null
let currentSchema: string | null = null
/** The restore handle `installTestWiki()` hands back, held so `teardownTestDb()` can put back
 *  whatever `globalThis.WIKI` was before rather than leaving this fixture's `WIKI` in place for
 *  whatever runs next in the same file (see #1021). */
let wikiHandle: { restore(): void } | null = null

/**
 * Connect, create a fresh schema, migrate, install `WIKI`, and seed one site/user/group.
 *
 * Each call gets its own randomly-named schema rather than reusing a fixed one (`public`): `node
 * --test` runs matched files concurrently by default, and every DB-backed suite in this repo points
 * at the same `DATABASE_URL` — a shared schema would mean two suites' `DROP SCHEMA` / `CREATE SCHEMA`
 * racing each other. A schema of its own is what makes a suite's "no leaking state between runs"
 * true even when another suite is mid-run against the same physical database at the same time.
 *
 * @throws If `DATABASE_URL` is unset — callers must check `hasTestDatabase()` first and skip instead.
 */
export async function setupTestDb(): Promise<TestFixtures> {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'setupTestDb() called without DATABASE_URL set — gate the suite on hasTestDatabase() instead.'
    )
  }

  const schema = `test_${randomBytes(6).toString('hex')}`
  // -> `public` stays on the search path behind the test schema: a postgres extension is a
  //    per-database object, not a per-schema one, so whichever suite happens to create `ltree` first
  //    owns it — every other suite's schema still needs to see it, or its migration fails on a type
  //    it does not consider itself to have. Installing extensions into `public` explicitly (below)
  //    and keeping it visible here is what lets every concurrently-running suite share them safely.
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
    .returning({ id: sitesTable.id })

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

  // -> The pre-squash migration history (task 2) used to seed these three fixed-id rows directly in
  //    the `ALTER TABLE` migration that added `pages.classification` — that statement existed only to
  //    backfill an already-existing install's pages when the NOT NULL column was added, so squashing
  //    the whole history into one genesis `CREATE TABLE` (which needs no backfill) dropped it: a fresh
  //    schema has no seed data of its own. A real boot re-seeds them anyway
  //    (`core/config.ts#initDbValues()` -> `models.classificationLevels.init()`, idempotent via
  //    `onConflictDoNothing`) using the exact fixed ids `base.yml`'s `systemIds` declares, so this
  //    fixture seeds the same three rows at the same ids directly, matching what a real boot ends up
  //    with — the same "Public" a fresh install gets.
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
  // -> The floor invariant (#1080) reads the in-memory cache, not the db directly — see
  //    `models/classificationLevels.ts`. Without this, a model test calling `createPage()`/`movePage()`
  //    would see an empty level list and fail `defaultLevel()`'s guard.
  await models.classificationLevels.reloadCache()

  WIKI.sites[site!.id] = {
    id: site!.id,
    config: { locales: { primary: 'en', active: ['en', 'fr'] } }
  }

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
 * Create `REQUIRED_EXTENSIONS` in `public`, serialized against every other suite doing the same.
 *
 * A session-scoped advisory lock, not just `IF NOT EXISTS`: postgres's own existence check for
 * `CREATE EXTENSION IF NOT EXISTS` is not atomic against another session doing the same thing at the
 * same moment, and two suites' setup racing to create `ltree` for the first time hits a duplicate-key
 * error on `pg_extension` despite the guard. The lock and its release have to run on the exact same
 * physical connection — a `Pool` query checks a connection out and back in per call, so a lock taken
 * through `db.execute()` could be released from a different one — hence the dedicated client here
 * rather than reusing the pool passed to `drizzle()`.
 *
 * Exported (not just used by `setupTestDb()`) so a suite that cannot use `setupTestDb()` wholesale —
 * one that needs its own hand-rolled minimal fixture with no pre-seeded rows — can still get the same
 * race-free extension setup, against the caller's own `Pool`, rather than duplicating this lock dance.
 * `core/config.test.ts`'s `ensureSeeded()` suite is one such case.
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
  /**
   * Full path, e.g. `'docs/child'` — split into `folderPath`/`fileName` the same way
   * `models/tree.ts` encodes one: lowercased, `/` become `.` (`helpers/common.ts#encodeTreePath`).
   * Ignored when `folderPath`/`fileName` are given directly, which is the escape hatch for a path
   * `encodeTreePath` can't express.
   */
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
 * Seed one `tree` row directly — a page, folder, or asset entry — for tests exercising
 * `models/navigation.ts` or anything else keyed off the tree, without going through
 * `models/pages.ts#createPage`'s full write path (which also touches `pages`/`pageHistory` this
 * fixture has no use for).
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
 * Drops this suite's schema and closes the pool.
 *
 * Call from `after()`: dropping the schema is what keeps a long-running shared instance (the
 * `.devcontainer` postgres, or a container reused across several local test invocations) from
 * accumulating one abandoned schema per run, and closing the pool is what lets the process exit
 * instead of hanging on an open socket.
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
 * Seed one `locales` row directly — the `locales` table starts empty for a fresh `setupTestDb()`
 * schema, but `models/locales.ts#getLocales()` (and therefore `isReservedLocaleCode()`) reads
 * through it, so a suite exercising the reserved-locale-segment checks needs at least the codes it
 * asserts against actually installed. `code` is split on its first `-` into `language`/`region` the
 * same way `models/locales.ts#localeCode` composes one — enough for every fixture's purposes (`en`,
 * `fr`, `pt-BR`); pass `region`/`script` directly for anything more specific.
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
 * The minimal `WIKI` global these tests need. Not the full boot sequence in `index.ts` — that also
 * starts the HTTP server, the scheduler's thread pool and the postgres LISTEN/NOTIFY subscription,
 * none of which model-layer logic touches, and any one of which is a reason a test could hang or
 * flake for a cause unrelated to the code under test.
 *
 * The shape itself is `test/mocks.ts#createWikiStub()`'s (TEST-F1) — this adds only the three members
 * a DB-backed run needs on top of it, and keeps the restore handle for `teardownTestDb()`.
 */
function installDbTestWiki(db: WikiDb, models: typeof import('../models/index.ts').default): void {
  // -> Puppeteer is never installed in this test environment, so the real `ensureCanRender()` would
  //    refuse every render-less `createPage()`/`updatePage()` call (OpenProject #1716) -- stubbed out
  //    here, the same way `cache`/`events`/`scheduler` are, so a suite with no reason to care
  //    about server-side rendering doesn't have to mock it just to call `createPage()` with plain
  //    content. A suite that DOES care (`models/pages.test.ts`'s own describe block) re-wraps this
  //    with `mock.method()`, which fully replaces this implementation rather than layering on it.
  models.renderQueue.ensureCanRender = async () => {}
  wikiHandle = installTestWiki({
    db,
    // -> `helpers/advisoryLock.ts#getLockPool()` lazily builds its dedicated lock pool from
    //    `WIKI.dbManager.config` (a real boot populates this once `dbManager.init()` runs) --
    //    a suite that exercises the real `withAdvisoryLock` (not the dependency-injected fakes
    //    most task-level tests use) needs this present, or it crashes reading `.config` off
    //    `undefined` (OpenProject #2347). Only `config.connectionString` is provided: nothing
    //    under a DB-backed suite reaches `dbManager.pool`/`listenerPool`/etc. through this stub.
    dbManager: { config: { connectionString: process.env.DATABASE_URL } },
    models
  })
}
