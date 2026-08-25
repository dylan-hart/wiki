/**
 * DB-backed round trip for `db/migrations/20260825203005_main` (WP #1846): a legacy row that
 * predates the `userAvatars`/`siteAssets` `hash` column must come out of that migration with a sha1
 * hex digest of its own `data`, not just a not-null constraint nothing has populated.
 *
 * Not co-located with `db/schema.test.ts`: that file is pure-unit (introspects `schema.ts`'s
 * `PgTable` config, no database), while this is a real migration round trip spanning `db/schema.ts`
 * and one specific file under `db/migrations/` — the DB-backed exception "Testing (backend)" in
 * CLAUDE.md carves out for exactly this shape, with no single co-located source file to sit next to.
 *
 * `setupTestDb()` is not used here: it runs every migration up front, and by then `hash` already
 * exists as `NOT NULL` on both tables, so there is no legacy-shaped row left to seed. Instead this
 * migrates a fresh schema up to (but not including) the hash-column migration, seeds a row the way
 * an existing installation would already have one — via raw SQL, since the `userAvatars`/`siteAssets`
 * Drizzle table objects are typed against *today's* schema and would refuse a row with no `hash` —
 * then runs the remaining migration and asserts the backfill it contains actually ran.
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq, sql } from 'drizzle-orm'
import { relations } from '../db/relations.ts'
import { siteAssets as siteAssetsTable, sites as sitesTable, userAvatars } from '../db/schema.ts'
import { ensureRequiredExtensions, hasTestDatabase } from './db.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.join(HERE, '../db/migrations')
/** The one migration under test — deliberately a fixed name, not "whatever sorts last": a later
 *  migration added after this one must not silently take its place here. */
const HASH_BACKFILL_MIGRATION = '20260825203005_main'

describe('hash column backfill migration', { skip: !hasTestDatabase() }, () => {
  let pool: Pool
  let db: ReturnType<typeof drizzle>
  let schema: string
  let preMigrationsDir: string

  before(async () => {
    schema = `test_hashbackfill_${crypto.randomBytes(6).toString('hex')}`
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${schema},public`
    })
    db = drizzle({ client: pool, relations })

    await db.execute(sql.raw(`CREATE SCHEMA "${schema}"`))
    await ensureRequiredExtensions(pool)

    // A scratch copy of every migration folder except the one under test, so `migrate()` can bring
    // this schema up to "the moment before `hash` existed" -- `migrate()` reads `migration.sql` out
    // of each subdirectory of the folder it's pointed at (see `readMigrationFiles` in
    // `drizzle-orm/migrator.js`), so a plain filesystem copy is all a partial run needs.
    preMigrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-premigrate-'))
    for (const entry of fs.readdirSync(MIGRATIONS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === HASH_BACKFILL_MIGRATION) continue
      fs.cpSync(path.join(MIGRATIONS_DIR, entry.name), path.join(preMigrationsDir, entry.name), {
        recursive: true
      })
    }

    await migrate(db, {
      migrationsFolder: preMigrationsDir,
      migrationsSchema: schema,
      migrationsTable: 'migrations'
    })
  })

  after(async () => {
    if (preMigrationsDir) {
      fs.rmSync(preMigrationsDir, { recursive: true, force: true })
    }
    if (pool) {
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`))
      await pool.end()
    }
  })

  test('backfills a sha1 hex hash for every pre-existing avatar and site-asset row', async () => {
    const [site] = await db
      .insert(sitesTable)
      .values({ hostname: 'hash-backfill.localhost', isEnabled: true, config: {} })
      .returning({ id: sitesTable.id })

    const avatarId = crypto.randomUUID()
    const avatarData = Buffer.from('legacy-avatar-bytes')
    const assetData = Buffer.from('legacy-logo-bytes')

    // Raw SQL: at this point in the migration history `hash` does not exist on either table yet, so
    // these rows are exactly what a pre-#1846 installation already has sitting in its database.
    await db.execute(sql`INSERT INTO "userAvatars" (id, data) VALUES (${avatarId}, ${avatarData})`)
    await db.execute(
      sql`INSERT INTO "siteAssets" ("siteId", kind, data) VALUES (${site!.id}, 'logo', ${assetData})`
    )

    // Apply the remaining migration -- just the hash-column one, backfill included.
    await migrate(db, {
      migrationsFolder: MIGRATIONS_DIR,
      migrationsSchema: schema,
      migrationsTable: 'migrations'
    })

    const [avatarRow] = await db
      .select({ hash: userAvatars.hash })
      .from(userAvatars)
      .where(eq(userAvatars.id, avatarId))
    const [assetRow] = await db
      .select({ hash: siteAssetsTable.hash })
      .from(siteAssetsTable)
      .where(eq(siteAssetsTable.siteId, site!.id))

    assert.equal(avatarRow?.hash, crypto.createHash('sha1').update(avatarData).digest('hex'))
    assert.equal(assetRow?.hash, crypto.createHash('sha1').update(assetData).digest('hex'))
  })
})
