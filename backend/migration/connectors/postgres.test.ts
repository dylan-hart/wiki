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

let dbAvailable = true

before(async () => {
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

  test('every entity generator is a deferred stub, not implemented here', () => {
    const connector = new PostgresSourceConnector({
      host: HOST,
      port: PORT,
      database: DATABASE,
      user: USER,
      password: PASSWORD
    })
    for (const method of [
      'users',
      'groups',
      'pages',
      'pageHistory',
      'tags',
      'navigation',
      'settings',
      'assets'
    ] as const) {
      assert.throws(() => connector[method](), NotYetImplementedError)
    }
  })
})
