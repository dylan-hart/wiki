import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { randomBytes } from 'node:crypto'
import { Client } from 'pg'
import { PostgresSourceConnector } from './postgres.ts'
import { LEGACY_SCHEMA_DDL } from '../../test/migrationFixtures.ts'

/**
 * Smoke coverage for `PostgresSourceConnector`, scoped to exactly what this task builds: the
 * connect/disconnect/describe lifecycle and the schema-introspection shape check. No row is ever
 * read — see the generator smoke test at the bottom.
 *
 * Connection parameters come from `DATABASE_URL` when set — the same single-source-of-truth every
 * `setupTestDb()` suite already keys off via `hasTestDatabase()` (see `test/db.ts` and "Testing
 * (backend)" in CLAUDE.md), which is what lets this file run for real in CI (`quality.yml` exports
 * `DATABASE_URL` for its `postgres:18` service, but no `MIGRATION_TEST_PG_*` var). Absent that, it
 * falls back to the standalone `MIGRATION_TEST_PG_*` vars, for a developer running just this file
 * against its own throwaway container: `docker run --rm -d --name wiki-test-db-712 -p 56071:5432 -e
 * POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres postgres:18`. Skips itself with a clear message
 * if nothing usable is reachable either way, rather than failing the whole suite in an environment
 * with neither Docker nor `DATABASE_URL`.
 *
 * -> Isolation, when driven off `DATABASE_URL`, is a private *database* per run, not a private
 *    schema like every `setupTestDb()` suite uses. This suite's fixture tables (`pages`/`users`/
 *    `groups`/...) exist to be probed by `PostgresSourceConnector#checkShape()`, which — correctly,
 *    since a real 2.5.x install never used anything else — introspects
 *    `information_schema.columns WHERE table_schema = 'public'` literally (see `postgres.ts`, whose
 *    `PostgresSourceConfig` deliberately has no schema field, for the same reason). A same-database,
 *    differently-named schema would be invisible to `checkShape()` no matter what the connection's
 *    `search_path` says — `table_schema` reports a table's real catalog schema, not whatever
 *    resolves first on the path — so it can't give this suite the isolation `setupTestDb()` gets
 *    from it. A private database's own default `public` schema is the only namespace
 *    `checkShape()` will ever look at, so a private database per run is what actually keeps two
 *    concurrent invocations against the same `DATABASE_URL` from colliding.
 */
interface ConnectionParams {
  host: string
  port: number
  database: string
  user: string
  password: string
}

function baseConnectionParams(): ConnectionParams {
  if (process.env.DATABASE_URL) {
    const url = new URL(process.env.DATABASE_URL)
    return {
      host: url.hostname,
      port: Number(url.port || 5432),
      database: url.pathname.replace(/^\//, '') || 'postgres',
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password)
    }
  }
  return {
    host: process.env.MIGRATION_TEST_PG_HOST ?? '127.0.0.1',
    port: Number(process.env.MIGRATION_TEST_PG_PORT ?? 56071),
    database: process.env.MIGRATION_TEST_PG_DB ?? 'postgres',
    user: process.env.MIGRATION_TEST_PG_USER ?? 'postgres',
    password: process.env.MIGRATION_TEST_PG_PASSWORD ?? 'postgres'
  }
}

const usingDatabaseUrl = Boolean(process.env.DATABASE_URL)
const base = baseConnectionParams()

const HOST = base.host
const PORT = base.port
const USER = base.user
const PASSWORD = base.password

// -> Deliberately a top-level `await`, not a `before()` hook: every `{ skip: !dbAvailable && '...' }`
//    below is an options object built while this module's top-level code is still running — i.e.
//    while `describe()`/`test()` calls are registering the suite, synchronously, top to bottom. A
//    `before()` hook's body does not run until the run phase that follows, so if the probe lived in
//    one, every `skip` option would still see `dbAvailable`'s initial value (`true`) and never
//    actually skip. Top-level `await` runs to completion before any of the registration code below it
//    executes, which is what makes the probe's result — and, on the `DATABASE_URL` path, the private
//    database's final name — visible in time for `skip` and the fixture clients below to see it.
let dbAvailable = true
let DATABASE = base.database
let privateDatabaseName: string | null = null

if (usingDatabaseUrl) {
  // Connects to `base.database` (`DATABASE_URL`'s own database) purely to issue `CREATE DATABASE` —
  // this suite's fixture tables never live there, only in the private database it creates below.
  const maintenance = new Client({
    host: HOST,
    port: PORT,
    database: base.database,
    user: USER,
    password: PASSWORD
  })
  try {
    await maintenance.connect()
    const candidate = `migration_test_${randomBytes(6).toString('hex')}`
    await maintenance.query(`CREATE DATABASE "${candidate}"`)
    privateDatabaseName = candidate
    DATABASE = candidate
  } catch {
    dbAvailable = false
  } finally {
    await maintenance.end().catch(() => {})
  }
} else {
  const probe = new Client({
    host: HOST,
    port: PORT,
    database: DATABASE,
    user: USER,
    password: PASSWORD
  })
  try {
    await probe.connect()
    await probe.end()
  } catch {
    dbAvailable = false
  }
}

// Drops the private database this run created, once every test below has closed its own connection
// into it. A root-level `after()` hook (registered here, outside any `describe`) runs only once every
// child `describe`'s own hooks have already unwound, so this never races a still-open connection —
// and `WITH (FORCE)` (PostgreSQL 13+; this project requires 16+) is the backstop for the one anyway,
// terminating any connection a failed assertion left behind rather than letting that leak block
// cleanup and fail the whole suite's teardown.
after(async () => {
  if (!privateDatabaseName) return
  const maintenance = new Client({
    host: HOST,
    port: PORT,
    database: base.database,
    user: USER,
    password: PASSWORD
  })
  try {
    await maintenance.connect()
    await maintenance.query(`DROP DATABASE IF EXISTS "${privateDatabaseName}" WITH (FORCE)`)
  } finally {
    await maintenance.end().catch(() => {})
  }
})

describe('PostgresSourceConnector', () => {
  test('rejects connecting to an unreachable host', async () => {
    const connector = new PostgresSourceConnector({
      host: '127.0.0.1',
      port: 1,
      database: 'nope',
      user: 'nope',
      password: 'nope'
    })
    await assert.rejects(() => connector.connect())
  })

  test(
    'rejects a database missing the expected 2.5.x tables',
    { skip: !dbAvailable && 'no test Postgres reachable' },
    async () => {
      // Runs before the "shaped schema" block below creates its tables, so `public` is still
      // pristine and the introspection check has genuinely nothing 2.5.x-shaped to find.
      const admin = new Client({
        host: HOST,
        port: PORT,
        database: DATABASE,
        user: USER,
        password: PASSWORD
      })
      await admin.connect()
      await admin.query('DROP TABLE IF EXISTS pages, users, groups, knex_migrations')
      await admin.end()

      const connector = new PostgresSourceConnector({
        host: HOST,
        port: PORT,
        database: DATABASE,
        user: USER,
        password: PASSWORD
      })
      await assert.rejects(
        () => connector.connect(),
        /does not look like a 2\.5\.x Wiki\.js database/
      )
    }
  )

  describe(
    'against a 2.5.x-shaped schema',
    { skip: !dbAvailable && 'no test Postgres reachable' },
    () => {
      let admin: Client

      before(async () => {
        if (!dbAvailable) return
        admin = new Client({
          host: HOST,
          port: PORT,
          database: DATABASE,
          user: USER,
          password: PASSWORD
        })
        await admin.connect()
        await admin.query('DROP TABLE IF EXISTS pages, users, groups, knex_migrations')
        await admin.query(LEGACY_SCHEMA_DDL.pages!)
        await admin.query(LEGACY_SCHEMA_DDL.users!)
        await admin.query(LEGACY_SCHEMA_DDL.groups!)
        await admin.query(LEGACY_SCHEMA_DDL.knexMigrations!)
        await admin.query(`INSERT INTO knex_migrations (name) VALUES ('2.4.61.js'), ('2.5.12.js')`)
      })

      after(async () => {
        if (!dbAvailable) return
        await admin.query('DROP TABLE IF EXISTS pages, users, groups, knex_migrations')
        await admin.end()
      })

      test('connects, reports describe() with detected version and shape notes, then disconnects', async () => {
        const connector = new PostgresSourceConnector({
          host: HOST,
          port: PORT,
          database: DATABASE,
          user: USER,
          password: PASSWORD
        })
        await connector.connect()
        const description = await connector.describe()
        assert.equal(description.kind, 'postgres')
        assert.equal(description.location, `${HOST}:${PORT}/${DATABASE}`)
        assert.equal(description.version, '2.5.12.js')
        assert.ok(description.notes.some((n) => n.includes('"pages"')))
        assert.ok(description.notes.some((n) => n.includes('"users"')))
        assert.ok(description.notes.some((n) => n.includes('"groups"')))
        await connector.disconnect()
      })

      test('describe() throws when called before connect()', async () => {
        const connector = new PostgresSourceConnector({
          host: HOST,
          port: PORT,
          database: DATABASE,
          user: USER,
          password: PASSWORD
        })
        await assert.rejects(() => connector.describe(), /before a successful connect/)
      })
    }
  )

  test('pages()/pageHistory()/tags()/navigation()/users()/groups()/settings()/comments()/assets() reject when called before connect()', async () => {
    const connector = new PostgresSourceConnector({
      host: HOST,
      port: PORT,
      database: DATABASE,
      user: USER,
      password: PASSWORD
    })
    for (const method of [
      'pages',
      'pageHistory',
      'tags',
      'navigation',
      'users',
      'groups',
      'settings',
      'comments',
      'assets'
    ] as const) {
      const iterable = connector[method]()
      await assert.rejects(async () => {
        for await (const _row of iterable) {
          // draining is enough to trigger the guard on first next()
        }
      }, /before a successful connect/)
    }
  })

  describe(
    'pages()/pageHistory()/tags()/navigation() against a 2.5.x-shaped schema (Task 733)',
    { skip: !dbAvailable && 'no test Postgres reachable' },
    () => {
      let admin: Client

      async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
        const out: T[] = []
        for await (const item of iterable) out.push(item)
        return out
      }

      before(async () => {
        if (!dbAvailable) return
        admin = new Client({
          host: HOST,
          port: PORT,
          database: DATABASE,
          user: USER,
          password: PASSWORD
        })
        await admin.connect()
        await admin.query(
          'DROP TABLE IF EXISTS "pageHistoryTags", "pageTags", "pageHistory", pages, tags, navigation, users, groups'
        )
        // connect()'s checkShape() introspects users/groups too, even though this describe block
        // never reads through those two generators — see the "against a 2.5.x-shaped schema" describe
        // above, whose own `after` already dropped the tables it created there.
        await admin.query(LEGACY_SCHEMA_DDL.users!)
        await admin.query(LEGACY_SCHEMA_DDL.groups!)
        await admin.query(LEGACY_SCHEMA_DDL.pagesFull!)
        await admin.query(LEGACY_SCHEMA_DDL.pageHistory!)
        await admin.query(LEGACY_SCHEMA_DDL.tags!)
        await admin.query(LEGACY_SCHEMA_DDL.pageTags!)
        await admin.query(LEGACY_SCHEMA_DDL.pageHistoryTags!)
        await admin.query(LEGACY_SCHEMA_DDL.navigation!)

        await admin.query(`
          INSERT INTO pages (id, path, "localeCode", hash, title, "contentType", "authorId", "creatorId")
          VALUES
            (1, 'welcome', 'en', 'hash-1', 'Welcome', 'markdown', 10, 10),
            (2, 'welcome', 'fr', 'hash-2', 'Bienvenue', 'markdown', 11, NULL)
        `)
        await admin.query(`
          INSERT INTO "pageHistory" (id, "pageId", path, "localeCode", title, action, "versionDate", "authorId")
          VALUES
            (100, 1, 'welcome', 'en', 'Welcome', 'updated', '2020-01-02T00:00:00.000Z', 10),
            (101, 1, 'welcome', 'en', 'Welcome', 'created', '2020-01-01T00:00:00.000Z', 10)
        `)
        await admin.query(`INSERT INTO tags (id, tag, title) VALUES (1, 'intro', 'Intro')`)
        await admin.query(`INSERT INTO "pageTags" (id, "pageId", "tagId") VALUES (1, 1, 1)`)
        await admin.query(
          `INSERT INTO "pageHistoryTags" (id, "pageId", "tagId") VALUES (1, 100, 1)`
        )
        await admin.query(
          `INSERT INTO navigation (key, config) VALUES ('site', '[{"id":"home","label":"Home"}]')`
        )
      })

      after(async () => {
        if (!dbAvailable) return
        await admin.query(
          'DROP TABLE IF EXISTS "pageHistoryTags", "pageTags", "pageHistory", pages, tags, navigation, users, groups'
        )
        await admin.end()
      })

      test('pages() yields every page with its resolved tags array', async () => {
        const connector = new PostgresSourceConnector({
          host: HOST,
          port: PORT,
          database: DATABASE,
          user: USER,
          password: PASSWORD
        })
        await connector.connect()
        const rows = await collect(connector.pages())
        assert.equal(rows.length, 2)
        const page1 = rows.find((r) => r.id === 1)!
        assert.deepEqual(page1.tags, [{ tag: 'intro', title: 'Intro' }])
        const page2 = rows.find((r) => r.id === 2)!
        assert.deepEqual(page2.tags, [])
        await connector.disconnect()
      })

      test('pageHistory() yields every revision, ordered by pageId then versionDate, with resolved tags', async () => {
        const connector = new PostgresSourceConnector({
          host: HOST,
          port: PORT,
          database: DATABASE,
          user: USER,
          password: PASSWORD
        })
        await connector.connect()
        const rows = await collect(connector.pageHistory())
        assert.deepEqual(
          rows.map((r) => r.id),
          [101, 100]
        )
        const updated = rows.find((r) => r.id === 100)!
        assert.deepEqual(updated.tags, [{ tag: 'intro', title: 'Intro' }])
        const created = rows.find((r) => r.id === 101)!
        assert.deepEqual(created.tags, [])
        await connector.disconnect()
      })

      test('pageHistory() yields each row exactly once across a tie straddling the batch boundary (WP 1780)', async () => {
        // pageHistory()'s ORDER BY is `ph."pageId", ph."versionDate", ph.id` -- the trailing `ph.id`
        // is the fix under test. Without it, ties on (pageId, versionDate) are broken arbitrarily by
        // Postgres and can differ between paginatedQuery()'s separate LIMIT/OFFSET statements, letting
        // a tied row be yielded twice (or dropped) when the tie group straddles a batch boundary.
        // PAGE_BATCH_SIZE is 10, so this seeds one page (id 5) with 11 revisions: 9 with distinct
        // versionDates, then a tied pair (ids 309/310, same versionDate) landing exactly on rows 10
        // and 11 of the final order -- the last row of batch 1 (OFFSET 0) and the first row of batch 2
        // (OFFSET 10).
        await admin.query(`
          INSERT INTO "pageHistory" (id, "pageId", path, "localeCode", title, action, "versionDate", "authorId")
          VALUES
            (300, 5, 'tie', 'en', 'Tie', 'updated', '2020-02-01T00:00:00.001Z', 10),
            (301, 5, 'tie', 'en', 'Tie', 'updated', '2020-02-01T00:00:00.002Z', 10),
            (302, 5, 'tie', 'en', 'Tie', 'updated', '2020-02-01T00:00:00.003Z', 10),
            (303, 5, 'tie', 'en', 'Tie', 'updated', '2020-02-01T00:00:00.004Z', 10),
            (304, 5, 'tie', 'en', 'Tie', 'updated', '2020-02-01T00:00:00.005Z', 10),
            (305, 5, 'tie', 'en', 'Tie', 'updated', '2020-02-01T00:00:00.006Z', 10),
            (306, 5, 'tie', 'en', 'Tie', 'updated', '2020-02-01T00:00:00.007Z', 10),
            (307, 5, 'tie', 'en', 'Tie', 'updated', '2020-02-01T00:00:00.008Z', 10),
            (308, 5, 'tie', 'en', 'Tie', 'updated', '2020-02-01T00:00:00.009Z', 10),
            (309, 5, 'tie', 'en', 'Tie', 'updated', '2020-02-01T00:00:00.010Z', 10),
            (310, 5, 'tie', 'en', 'Tie', 'updated', '2020-02-01T00:00:00.010Z', 10)
        `)

        const connector = new PostgresSourceConnector({
          host: HOST,
          port: PORT,
          database: DATABASE,
          user: USER,
          password: PASSWORD
        })
        await connector.connect()
        const rows = await collect(connector.pageHistory())
        await connector.disconnect()

        // No duplicates and nothing dropped, across the whole table (not just the seeded tie group) --
        // this is what paginatedQuery()'s totality precondition guarantees once the ORDER BY is total.
        const ids = rows.map((r) => r.id as number)
        assert.equal(new Set(ids).size, ids.length, 'pageHistory() yielded a duplicate row id')

        const tieGroupIds = ids.filter((id) => id >= 300 && id <= 310).sort((a, b) => a - b)
        assert.deepEqual(tieGroupIds, [300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 310])
      })

      test('tags() yields the raw tags table', async () => {
        const connector = new PostgresSourceConnector({
          host: HOST,
          port: PORT,
          database: DATABASE,
          user: USER,
          password: PASSWORD
        })
        await connector.connect()
        const rows = await collect(connector.tags())
        assert.deepEqual(rows, [{ id: 1, tag: 'intro', title: 'Intro' }])
        await connector.disconnect()
      })

      test('navigation() yields the raw navigation row(s)', async () => {
        const connector = new PostgresSourceConnector({
          host: HOST,
          port: PORT,
          database: DATABASE,
          user: USER,
          password: PASSWORD
        })
        await connector.connect()
        const rows = await collect(connector.navigation())
        assert.equal(rows.length, 1)
        assert.equal(rows[0].key, 'site')
        assert.deepEqual(rows[0].config, [{ id: 'home', label: 'Home' }])
        await connector.disconnect()
      })
    }
  )

  describe(
    'users()/groups() against a 2.5.x-shaped schema (Task 8)',
    { skip: !dbAvailable && 'no test Postgres reachable' },
    () => {
      let admin: Client

      async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
        const out: T[] = []
        for await (const item of iterable) out.push(item)
        return out
      }

      before(async () => {
        if (!dbAvailable) return
        admin = new Client({
          host: HOST,
          port: PORT,
          database: DATABASE,
          user: USER,
          password: PASSWORD
        })
        await admin.connect()
        await admin.query('DROP TABLE IF EXISTS "userGroups", pages, users, groups')
        // connect()'s checkShape() introspects pages too, even though this describe block never
        // reads through pages() — see the "against a 2.5.x-shaped schema" describe above.
        await admin.query(LEGACY_SCHEMA_DDL.pages!)
        await admin.query(LEGACY_SCHEMA_DDL.users!)
        await admin.query(LEGACY_SCHEMA_DDL.groups!)
        await admin.query(LEGACY_SCHEMA_DDL.userGroups!)

        await admin.query(`
          INSERT INTO groups (id, name, permissions, "pageRules")
          VALUES
            (1, 'Administrators', '[]', '[]'),
            (2, 'Editors', '[]', '[]')
        `)
        await admin.query(`
          INSERT INTO users (id, email, "providerKey", "tfaIsActive")
          VALUES
            (1, 'both@example.com', 'local', false),
            (2, 'none@example.com', 'local', false)
        `)
        // user 1 belongs to both groups (inserted out of id order, to prove the ORDER BY g.id inside
        // json_agg is doing the sorting, not insertion order); user 2 belongs to none.
        await admin.query(`
          INSERT INTO "userGroups" (id, "userId", "groupId")
          VALUES
            (1, 1, 2),
            (2, 1, 1)
        `)
      })

      after(async () => {
        if (!dbAvailable) return
        await admin.query('DROP TABLE IF EXISTS "userGroups", pages, users, groups')
        await admin.end()
      })

      test('groups() yields plain group rows ordered by id', async () => {
        const connector = new PostgresSourceConnector({
          host: HOST,
          port: PORT,
          database: DATABASE,
          user: USER,
          password: PASSWORD
        })
        await connector.connect()
        const rows = await collect(connector.groups())
        assert.deepEqual(
          rows.map((r) => r.id),
          [1, 2]
        )
        assert.equal(rows[0].name, 'Administrators')
        assert.equal(rows[1].name, 'Editors')
        await connector.disconnect()
      })

      test("users() embeds each user's group membership as {id, name} pairs", async () => {
        const connector = new PostgresSourceConnector({
          host: HOST,
          port: PORT,
          database: DATABASE,
          user: USER,
          password: PASSWORD
        })
        await connector.connect()
        const rows = await collect(connector.users())
        const user1 = rows.find((r) => r.id === 1)!
        assert.deepEqual(user1.groups, [
          { id: 1, name: 'Administrators' },
          { id: 2, name: 'Editors' }
        ])
        await connector.disconnect()
      })

      test('users() yields an empty groups array for a user with no group membership', async () => {
        const connector = new PostgresSourceConnector({
          host: HOST,
          port: PORT,
          database: DATABASE,
          user: USER,
          password: PASSWORD
        })
        await connector.connect()
        const rows = await collect(connector.users())
        const user2 = rows.find((r) => r.id === 2)!
        assert.deepEqual(user2.groups, [])
        await connector.disconnect()
      })
    }
  )

  describe(
    'settings()/comments() against a 2.5.x-shaped schema (Task 9)',
    { skip: !dbAvailable && 'no test Postgres reachable' },
    () => {
      let admin: Client

      async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
        const out: T[] = []
        for await (const item of iterable) out.push(item)
        return out
      }

      before(async () => {
        if (!dbAvailable) return
        admin = new Client({
          host: HOST,
          port: PORT,
          database: DATABASE,
          user: USER,
          password: PASSWORD
        })
        await admin.connect()
        await admin.query(
          'DROP TABLE IF EXISTS comments, settings, authentication, storage, pages, users, groups'
        )
        // connect()'s checkShape() introspects pages/users/groups too, even though this describe
        // block never reads through those generators — see the "against a 2.5.x-shaped schema"
        // describe above.
        await admin.query(LEGACY_SCHEMA_DDL.pages!)
        await admin.query(LEGACY_SCHEMA_DDL.users!)
        await admin.query(LEGACY_SCHEMA_DDL.groups!)
        await admin.query(LEGACY_SCHEMA_DDL.settings!)
        await admin.query(LEGACY_SCHEMA_DDL.authentication!)
        await admin.query(LEGACY_SCHEMA_DDL.storage!)
        await admin.query(LEGACY_SCHEMA_DDL.comments!)

        await admin.query(`
          INSERT INTO settings (key, value, "updatedAt")
          VALUES ('title', '"My Wiki"', '2020-01-01T00:00:00.000Z')
        `)
        await admin.query(`
          INSERT INTO authentication (key, "isEnabled", config, "selfRegistration", "domainWhitelist", "autoEnrollGroups", "order", "strategyKey", "displayName")
          VALUES ('local', true, '{}', false, '[]', '[]', 0, 'local', 'Local Authentication')
        `)
        await admin.query(`
          INSERT INTO storage (key, "isEnabled", mode, config, "syncInterval", state)
          VALUES ('disk', true, 'sync', '{}', null, '{}')
        `)
        await admin.query(`
          INSERT INTO comments (id, content, "createdAt", "updatedAt", "pageId", "authorId")
          VALUES
            (2, 'second comment', '2020-01-02T00:00:00.000Z', '2020-01-02T00:00:00.000Z', 1, 1),
            (1, 'first comment', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', 1, 1)
        `)
      })

      after(async () => {
        if (!dbAvailable) return
        await admin.query(
          'DROP TABLE IF EXISTS comments, settings, authentication, storage, pages, users, groups'
        )
        await admin.end()
      })

      test('settings() yields tagged rows from settings, authentication, and storage in that order', async () => {
        const connector = new PostgresSourceConnector({
          host: HOST,
          port: PORT,
          database: DATABASE,
          user: USER,
          password: PASSWORD
        })
        await connector.connect()
        const rows = await collect(connector.settings())
        assert.deepEqual(
          rows.map((r) => r.entity),
          ['settings', 'authentication', 'storage']
        )
        const settingsRow = rows[0]
        assert.equal(settingsRow.key, 'title')
        assert.equal(settingsRow.value, 'My Wiki')

        const authRow = rows[1]
        assert.equal(authRow.key, 'local')
        assert.equal(authRow.isEnabled, true)
        assert.equal(authRow.displayName, 'Local Authentication')

        const storageRow = rows[2]
        assert.equal(storageRow.key, 'disk')
        assert.equal(storageRow.mode, 'sync')
        await connector.disconnect()
      })

      test('comments() yields plain comment rows ordered by id', async () => {
        const connector = new PostgresSourceConnector({
          host: HOST,
          port: PORT,
          database: DATABASE,
          user: USER,
          password: PASSWORD
        })
        await connector.connect()
        const rows = await collect(connector.comments())
        assert.deepEqual(
          rows.map((r) => r.id),
          [1, 2]
        )
        assert.equal(rows[0].content, 'first comment')
        assert.equal(rows[1].content, 'second comment')
        await connector.disconnect()
      })
    }
  )

  describe(
    'assets() against a 2.5.x-shaped schema (Task 10)',
    { skip: !dbAvailable && 'no test Postgres reachable' },
    () => {
      let admin: Client

      async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
        const out: T[] = []
        for await (const item of iterable) out.push(item)
        return out
      }

      async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
        const chunks: Buffer[] = []
        for await (const chunk of stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        }
        return Buffer.concat(chunks)
      }

      const nestedAssetBytes = Buffer.from('nested asset bytes')
      const rootAssetBytes = Buffer.from('root asset bytes')

      before(async () => {
        if (!dbAvailable) return
        admin = new Client({
          host: HOST,
          port: PORT,
          database: DATABASE,
          user: USER,
          password: PASSWORD
        })
        await admin.connect()
        await admin.query(
          'DROP TABLE IF EXISTS "assetData", assets, "assetFolders", pages, users, groups'
        )
        // connect()'s checkShape() introspects pages/users/groups too, even though this describe
        // block never reads through those generators — see the "against a 2.5.x-shaped schema"
        // describe above.
        await admin.query(LEGACY_SCHEMA_DDL.pages!)
        await admin.query(LEGACY_SCHEMA_DDL.users!)
        await admin.query(LEGACY_SCHEMA_DDL.groups!)
        await admin.query(LEGACY_SCHEMA_DDL.assetFolders!)
        await admin.query(LEGACY_SCHEMA_DDL.assets!)
        await admin.query(LEGACY_SCHEMA_DDL.assetData!)

        // Two folders: a root-level 'docs', and 'sub' nested inside it -- id 2's parentId chains
        // through id 1, proving buildAssetFolderPaths() actually walks the adjacency list rather than
        // only handling a single level.
        await admin.query(`
          INSERT INTO "assetFolders" (id, name, slug, "parentId")
          VALUES
            (1, 'docs', 'docs', NULL),
            (2, 'sub', 'sub', 1)
        `)
        await admin.query(
          `INSERT INTO assets (id, filename, hash, ext, mime, "createdAt", "updatedAt", "folderId", "authorId")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            10,
            'file.png',
            'hash-10',
            '.png',
            'image/png',
            '2020-01-01T00:00:00.000Z',
            '2020-01-02T00:00:00.000Z',
            2,
            5
          ]
        )
        await admin.query(
          `INSERT INTO assets (id, filename, hash, ext, mime, "createdAt", "updatedAt", "folderId", "authorId")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            11,
            'root.txt',
            'hash-11',
            '.txt',
            'text/plain',
            '2020-01-03T00:00:00.000Z',
            '2020-01-03T00:00:00.000Z',
            null,
            null
          ]
        )
        await admin.query(`INSERT INTO "assetData" (id, data) VALUES ($1, $2)`, [
          10,
          nestedAssetBytes
        ])
        await admin.query(`INSERT INTO "assetData" (id, data) VALUES ($1, $2)`, [
          11,
          rootAssetBytes
        ])
      })

      after(async () => {
        if (!dbAvailable) return
        await admin.query(
          'DROP TABLE IF EXISTS "assetData", assets, "assetFolders", pages, users, groups'
        )
        await admin.end()
      })

      test('assets() resolves a nested folder path from assetFolders', async () => {
        const connector = new PostgresSourceConnector({
          host: HOST,
          port: PORT,
          database: DATABASE,
          user: USER,
          password: PASSWORD
        })
        await connector.connect()
        const rows = await collect(connector.assets())
        const nested = rows.find((r) => r.filename === 'file.png')!
        assert.equal(nested.relativePath, 'docs/sub/file.png')
        await connector.disconnect()
      })

      test('assets() yields a bare filename for a root-level asset', async () => {
        const connector = new PostgresSourceConnector({
          host: HOST,
          port: PORT,
          database: DATABASE,
          user: USER,
          password: PASSWORD
        })
        await connector.connect()
        const rows = await collect(connector.assets())
        const root = rows.find((r) => r.filename === 'root.txt')!
        assert.equal(root.relativePath, 'root.txt')
        await connector.disconnect()
      })

      test('assets() carries authorId/mimeType/createdAt/updatedAt from the source row', async () => {
        const connector = new PostgresSourceConnector({
          host: HOST,
          port: PORT,
          database: DATABASE,
          user: USER,
          password: PASSWORD
        })
        await connector.connect()
        const rows = await collect(connector.assets())
        const nested = rows.find((r) => r.filename === 'file.png')!
        assert.equal(nested.authorId, 5)
        assert.equal(nested.mimeType, 'image/png')
        assert.deepEqual(nested.createdAt, new Date('2020-01-01T00:00:00.000Z'))
        assert.deepEqual(nested.updatedAt, new Date('2020-01-02T00:00:00.000Z'))
        await connector.disconnect()
      })

      test('assets() streams the joined assetData blob', async () => {
        const connector = new PostgresSourceConnector({
          host: HOST,
          port: PORT,
          database: DATABASE,
          user: USER,
          password: PASSWORD
        })
        await connector.connect()
        const rows = await collect(connector.assets())
        const nested = rows.find((r) => r.filename === 'file.png')!
        const bytes = await readAll(nested.stream)
        assert.ok(bytes.equals(nestedAssetBytes))

        const root = rows.find((r) => r.filename === 'root.txt')!
        const rootBytes = await readAll(root.stream)
        assert.ok(rootBytes.equals(rootAssetBytes))
        await connector.disconnect()
      })
    }
  )
})
