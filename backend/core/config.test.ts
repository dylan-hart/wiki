import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { sql } from 'drizzle-orm'
import configSvc from './config.ts'
import { relations } from '../db/relations.ts'
import { groups as groupsTable, sites as sitesTable } from '../db/schema.ts'
import { createExtensionsSerialized, hasTestDatabase } from '../test/db.ts'
import { createCacheStub, createEventsStub, createSchedulerStub } from '../test/mocks.ts'
import type { WikiDb } from './db.ts'

// `models/jobs.ts#init()` calls `Temporal.Now.instant()` unconditionally. Node ships `Temporal` as a
// global from v26 -- but not every environment running this test has that landed yet, and
// `@js-temporal/polyfill` (already pulled in transitively by drizzle-kit) is a faithful ponyfill, so
// install it as the global only when it is genuinely missing, exactly as `models/security.test.ts`
// does for the same reason.
if (typeof Temporal === 'undefined') {
  const { Temporal: TemporalPolyfill } = await import('@js-temporal/polyfill')
  ;(globalThis as any).Temporal = TemporalPolyfill
}

/**
 * Regression test for `config.init()`'s DB_PASS_FILE (Docker secret) handling: `.trim()` was called
 * on the *Promise* returned by `fs.readFile(...)` rather than on the resolved string, so every read
 * threw `promise.trim is not a function` — the `catch` block always ran and `process.exit(1)` killed
 * the process. Fixed by awaiting the read before calling `.trim()`.
 *
 * `WIKI.ROOTPATH`/`WIKI.SERVERPATH` point at a throwaway fixture directory rather than the real repo
 * files, so this stays a self-contained unit test of `init()`'s DB_PASS_FILE branch instead of also
 * exercising the real `config.yml`/`base.yml` contents.
 */

let dir: string
let dbPassFile: string
let previousWiki: any
let previousDbPassFile: string | undefined
let previousExit: typeof process.exit

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wikijs-config-test-'))

  await writeFile(
    path.join(dir, 'base.yml'),
    'defaults:\n  config:\n    port: 80\n    db:\n      host: localhost\n      pass: basedefaultpass\n'
  )
  await writeFile(path.join(dir, 'config.yml'), 'port: 3000\n')
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ version: '0.0.0-test', releaseDate: '2026-01-01', dev: true })
  )

  // Trailing newline, as a real Docker secret file (or `echo pass > file`) would produce — this is
  // what proves the fix actually trims the resolved string rather than just reading it.
  dbPassFile = path.join(dir, 'db-pass.txt')
  await writeFile(dbPassFile, 'sup3rSecret\n')

  previousWiki = (globalThis as any).WIKI
  ;(globalThis as any).WIKI = { ROOTPATH: dir, SERVERPATH: dir }

  previousDbPassFile = process.env.DB_PASS_FILE
  process.env.DB_PASS_FILE = dbPassFile

  // Pre-fix, the bug's catch block calls process.exit(1) — guard against actually killing the test
  // runner and instead surface it as a thrown assertion failure.
  previousExit = process.exit
  ;(process as any).exit = (code?: number) => {
    throw new Error(`process.exit(${code}) called — DB_PASS_FILE read/trim threw`)
  }
})

after(async () => {
  ;(globalThis as any).WIKI = previousWiki
  process.exit = previousExit
  if (previousDbPassFile === undefined) {
    delete process.env.DB_PASS_FILE
  } else {
    process.env.DB_PASS_FILE = previousDbPassFile
  }
  await rm(dir, { recursive: true, force: true })
})

test('reads and trims the DB_PASS_FILE contents into WIKI.config.db.pass', async () => {
  await configSvc.init(true)

  const wiki = (globalThis as any).WIKI
  assert.equal(wiki.config.db.pass, 'sup3rSecret')
})

/**
 * DB-backed regression coverage for OpenProject #2044: `ensureSeeded()` holds one advisory lock
 * across the is-empty check plus `initDbValues()`, so two instances booting against the same fresh
 * database can never interleave — see `ensureSeeded()`'s own doc comment in `config.ts`.
 *
 * Deliberately NOT built on `test/db.ts#setupTestDb()`: that fixture pre-inserts a site/user/group
 * directly (bypassing `initDbValues()` entirely) specifically so model tests have something to point
 * at, which would falsify this suite's own precondition — a database that is genuinely still empty.
 * This sets up the bare minimum instead: a fresh schema, migrated, with no rows of its own.
 */
describe('ensureSeeded() (DB-backed)', { skip: !hasTestDatabase() }, () => {
  const SYSTEM_IDS = {
    localAuthId: '5a528c4c-0a82-4ad2-96a5-2b23811e6588',
    guestsGroupId: '10000000-0000-4000-8000-000000000001',
    usersGroupId: '20000000-0000-4000-8000-000000000002',
    classificationPublicId: '30000000-0000-4000-8000-000000000001',
    classificationInternalId: '30000000-0000-4000-8000-000000000002',
    classificationRestrictedId: '30000000-0000-4000-8000-000000000003'
  }

  let pool: Pool
  let schema: string
  let db: WikiDb
  let previousDbWiki: any

  before(async () => {
    schema = `test_${randomBytes(6).toString('hex')}`
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${schema},public`
    })
    db = drizzle({ client: pool, relations }) as WikiDb

    await db.execute(sql.raw(`CREATE SCHEMA "${schema}"`))
    await createExtensionsSerialized(pool)
    await migrate(db, {
      migrationsFolder: path.join(import.meta.dirname, '../db/migrations'),
      migrationsSchema: schema,
      migrationsTable: 'migrations'
    })

    const models = (await import('../models/index.ts')).default

    previousDbWiki = (globalThis as any).WIKI
    ;(globalThis as any).WIKI = {
      IS_DEBUG: false,
      ROOTPATH: process.cwd(),
      SERVERPATH: path.join(import.meta.dirname, '..'),
      INSTANCE_ID: 'test',
      config: {},
      data: { systemIds: SYSTEM_IDS },
      db,
      logger: {
        error: () => {},
        warn: () => {},
        info: () => {},
        debug: () => {},
        verbose: () => {},
        silly: () => {}
      },
      cache: createCacheStub(),
      events: createEventsStub(),
      scheduler: createSchedulerStub(),
      models
    }
  })

  after(async () => {
    if (pool && schema) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    }
    await pool?.end()
    ;(globalThis as any).WIKI = previousDbWiki
  })

  test('exactly one of two concurrent callers seeds; the other observes a fully-seeded DB', async () => {
    const [first, second] = await Promise.all([configSvc.ensureSeeded(), configSvc.ensureSeeded()])

    // -> One caller performed the seed, the other found it already done — never both, and never
    //    neither (which the old, unlocked code could produce: both see `loadFromDb()` return
    //    `false` and both race straight into `initDbValues()`).
    assert.notEqual(first, second, `expected exactly one seed, got [${first}, ${second}]`)

    const siteCount = await db.$count(sitesTable)
    assert.equal(siteCount, 1, 'expected exactly one seeded site, not zero or a duplicate')

    const groupRows = await db.select({ id: groupsTable.id }).from(groupsTable)
    assert.equal(groupRows.length, 3, 'expected exactly the three standard groups')

    // -> Both calls must agree the DB is now seeded, proving the loser re-checked inside the lock
    // rather than trusting a stale read from before it blocked.
    assert.equal(await configSvc.loadFromDb(), true)
  })
})
