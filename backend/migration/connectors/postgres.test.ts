import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { Client } from 'pg'
import { NotYetImplementedError } from '../connector.ts'
import { PostgresSourceConnector } from './postgres.ts'

/**
 * Smoke coverage for `PostgresSourceConnector`, scoped to exactly what this task builds: the
 * connect/disconnect/describe lifecycle and the schema-introspection shape check. No row is ever
 * read — see the generator smoke test at the bottom.
 *
 * Needs a throwaway Postgres reachable at the env vars below (see the run instructions this task's
 * report cites: `docker run --rm -d --name wiki-test-db-712 -p 56071:5432 ...`). Skips itself with a
 * clear message if nothing answers there, rather than failing the whole suite in an environment with
 * no Docker.
 */
const HOST = process.env.MIGRATION_TEST_PG_HOST ?? '127.0.0.1'
const PORT = Number(process.env.MIGRATION_TEST_PG_PORT ?? 56071)
const DATABASE = process.env.MIGRATION_TEST_PG_DB ?? 'postgres'
const USER = process.env.MIGRATION_TEST_PG_USER ?? 'postgres'
const PASSWORD = process.env.MIGRATION_TEST_PG_PASSWORD ?? 'postgres'

// -> Deliberately a top-level `await`, not a `before()` hook: every `{ skip: !dbAvailable && '...' }`
//    below is an options object built while this module's top-level code is still running — i.e.
//    while `describe()`/`test()` calls are registering the suite, synchronously, top to bottom. A
//    `before()` hook's body does not run until the run phase that follows, so if the probe lived in
//    one, every `skip` option would still see `dbAvailable`'s initial value (`true`) and never
//    actually skip. Top-level `await` runs to completion before any of the registration code below it
//    executes, which is what makes the probe's result visible in time for `skip` to see it.
let dbAvailable = true
{
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
        await admin.query(`
        CREATE TABLE pages (
          id serial PRIMARY KEY,
          path varchar NOT NULL,
          hash varchar NOT NULL,
          "authorId" integer,
          "creatorId" integer,
          "contentType" varchar NOT NULL
        )
      `)
        await admin.query(`
        CREATE TABLE users (
          id serial PRIMARY KEY,
          email varchar NOT NULL,
          "providerKey" varchar NOT NULL DEFAULT 'local',
          "tfaIsActive" boolean NOT NULL DEFAULT false
        )
      `)
        await admin.query(`
        CREATE TABLE groups (
          id serial PRIMARY KEY,
          name varchar NOT NULL,
          permissions json NOT NULL,
          "pageRules" json NOT NULL,
          "redirectOnLogin" varchar NOT NULL DEFAULT '/'
        )
      `)
        await admin.query(`
        CREATE TABLE knex_migrations (
          id serial PRIMARY KEY,
          name varchar NOT NULL
        )
      `)
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

  test('users/groups/settings/assets generators remain deferred stubs (owned by other tasks)', () => {
    const connector = new PostgresSourceConnector({
      host: HOST,
      port: PORT,
      database: DATABASE,
      user: USER,
      password: PASSWORD
    })
    for (const method of ['users', 'groups', 'settings', 'assets'] as const) {
      assert.throws(() => connector[method](), NotYetImplementedError)
    }
  })

  test('pages()/pageHistory()/tags()/navigation() reject when called before connect()', async () => {
    const connector = new PostgresSourceConnector({
      host: HOST,
      port: PORT,
      database: DATABASE,
      user: USER,
      password: PASSWORD
    })
    for (const method of ['pages', 'pageHistory', 'tags', 'navigation'] as const) {
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
        await admin.query(`
          CREATE TABLE users (
            id serial PRIMARY KEY,
            email varchar NOT NULL,
            "providerKey" varchar NOT NULL DEFAULT 'local',
            "tfaIsActive" boolean NOT NULL DEFAULT false
          )
        `)
        await admin.query(`
          CREATE TABLE groups (
            id serial PRIMARY KEY,
            name varchar NOT NULL,
            permissions json NOT NULL,
            "pageRules" json NOT NULL,
            "redirectOnLogin" varchar NOT NULL DEFAULT '/'
          )
        `)
        await admin.query(`
          CREATE TABLE pages (
            id serial PRIMARY KEY,
            path varchar NOT NULL,
            "localeCode" varchar NOT NULL DEFAULT 'en',
            hash varchar NOT NULL,
            title varchar NOT NULL,
            "contentType" varchar NOT NULL,
            "authorId" integer,
            "creatorId" integer
          )
        `)
        await admin.query(`
          CREATE TABLE "pageHistory" (
            id serial PRIMARY KEY,
            "pageId" integer,
            path varchar NOT NULL,
            "localeCode" varchar NOT NULL DEFAULT 'en',
            title varchar NOT NULL,
            action varchar NOT NULL DEFAULT 'updated',
            "versionDate" varchar NOT NULL,
            "authorId" integer
          )
        `)
        await admin.query(`
          CREATE TABLE tags (
            id serial PRIMARY KEY,
            tag varchar NOT NULL UNIQUE,
            title varchar
          )
        `)
        await admin.query(`
          CREATE TABLE "pageTags" (
            id serial PRIMARY KEY,
            "pageId" integer,
            "tagId" integer
          )
        `)
        await admin.query(`
          CREATE TABLE "pageHistoryTags" (
            id serial PRIMARY KEY,
            "pageId" integer,
            "tagId" integer
          )
        `)
        await admin.query(`
          CREATE TABLE navigation (
            key varchar PRIMARY KEY,
            config json
          )
        `)

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
})
