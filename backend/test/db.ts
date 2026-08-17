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
 * else runs: one site, one user, one group — matching how a fresh Wiki.js installation seeds itself
 * (`core/config.ts#initDbValues`), just without the rest of that sequence (no default admin/guest
 * accounts, no settings rows) that these tests have no use for.
 *
 * Installs a minimal `WIKI` global alongside it — `db`, a quiet `logger`, `sites`, `config`, `models`,
 * plus the `cache`/`events` stubs from `./mocks.ts`. Safe to do once per test file: `node --test`
 * isolates each matched file into its own process by default, so this global does not leak into any
 * other file's run.
 */
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { sql } from 'drizzle-orm'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { relations } from '../db/relations.ts'
import { groups as groupsTable, sites as sitesTable, users as usersTable } from '../db/schema.ts'
import type { WikiDb } from '../core/db.ts'
import { createCacheStub, createEventsStub } from './mocks.ts'

/** Same list `core/db.ts` installs before migrating — the schema depends on both. */
const REQUIRED_EXTENSIONS = ['ltree', 'pg_trgm']

export interface TestFixtures {
  db: WikiDb
  siteId: string
  userId: string
  groupId: string
}

/** Whether a DB-backed suite may run at all. Gate every such `describe` on this. */
export function hasTestDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL)
}

let pool: Pool | null = null
let currentSchema: string | null = null

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
  await createExtensionsSerialized()
  await migrate(db, {
    migrationsFolder: path.join(import.meta.dirname, '../db/migrations'),
    migrationsSchema: schema,
    migrationsTable: 'migrations'
  })
  currentSchema = schema

  const models = (await import('../models/index.ts')).default
  installTestWiki(db, models)

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

  WIKI.sites[site!.id] = {
    id: site!.id,
    config: { locales: { primary: 'en', active: ['en', 'fr'] } }
  }

  return { db, siteId: site!.id, userId: user!.id, groupId: group!.id }
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
 */
async function createExtensionsSerialized(): Promise<void> {
  const client = await pool!.connect()
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
}

/**
 * The minimal `WIKI` global these tests need. Not the full boot sequence in `index.ts` — that also
 * starts the HTTP server, the scheduler's thread pool and the postgres LISTEN/NOTIFY subscription,
 * none of which model-layer logic touches, and any one of which is a reason a test could hang or
 * flake for a cause unrelated to the code under test.
 */
function installTestWiki(db: WikiDb, models: typeof import('../models/index.ts').default): void {
  global.WIKI = {
    IS_DEBUG: false,
    ROOTPATH: process.cwd(),
    SERVERPATH: path.join(process.cwd(), 'backend'),
    INSTANCE_ID: 'test',
    // -> Not `Temporal.Now.instant()`: nothing under test reads `startedAt`, and this file otherwise
    //    has no reason to depend on the runtime actually having native `Temporal` support.
    startedAt: new Date(),
    version: 'test',
    releaseDate: 'test',
    devMode: true,
    auth: { groups: {}, strategies: {} },
    config: {},
    data: {},
    db,
    logger: createSilentLogger(),
    cache: createCacheStub(),
    events: createEventsStub(),
    sites: {},
    sitesMappings: {},
    models
  } as unknown as WikiGlobal
}

/** `error`/`warn`/`info`/`debug`, all no-ops — a test run should not scroll past a model's own logging. */
function createSilentLogger(): any {
  const noop = () => {}
  return { error: noop, warn: noop, info: noop, debug: noop, verbose: noop, silly: noop }
}
