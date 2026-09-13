import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { parse } from 'pg-connection-string'

import { bootstrapPgvector } from './pgvectorBootstrap.ts'
import { relations } from '../db/relations.ts'
import { hasTestDatabase, setupTestDb, teardownTestDb } from '../test/db.ts'
import type { WikiDb } from './db.ts'

/**
 * Task 3095: `bootstrapPgvector()` is the optional, never-throws capability probe `syncSchemas()`
 * runs after migrations. DB-backed (real Postgres, real roles/privileges) rather than mocked, since
 * the thing under test in the negative case is a genuine permission denial from the server -- a
 * mocked `db.execute` would only assert that the code calls `catch`, not that it survives whatever
 * shape a real `CREATE EXTENSION`/`CREATE TABLE` failure actually takes. Gated on `hasTestDatabase()`
 * per CLAUDE.md.
 */
describe('bootstrapPgvector() -- optional pgvector capability (task 3095)', () => {
  const skip = hasTestDatabase() ? false : 'requires DATABASE_URL'
  let fixtures: Awaited<ReturnType<typeof setupTestDb>>
  let pgvectorAvailable = false

  before(async () => {
    if (!hasTestDatabase()) {
      return
    }
    fixtures = await setupTestDb()
    const res = await fixtures.db.execute(
      `SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`
    )
    pgvectorAvailable = res.rows.length > 0
  })

  after(async () => {
    if (!hasTestDatabase()) {
      return
    }
    await teardownTestDb()
  })

  test(
    'a role that lacks CREATE privilege on the schema gets false back, and no table is created',
    { skip },
    async () => {
      const { schema, db } = fixtures
      const parsed = parse(process.env.DATABASE_URL!)
      const roleName = `pgvector_test_${randomBytes(4).toString('hex')}`
      const rolePassword = randomBytes(12).toString('hex')

      const adminPool = new Pool({ connectionString: process.env.DATABASE_URL })
      let restrictedPool: Pool | undefined
      let roleCreated = false
      try {
        await adminPool.query(`CREATE ROLE "${roleName}" LOGIN PASSWORD '${rolePassword}'`)
        roleCreated = true
        // -> Grants the role CONNECT-equivalent visibility into this suite's schema (USAGE) but
        //    explicitly withholds CREATE at both the schema level (gates `CREATE TABLE`) and the
        //    database level (gates `CREATE EXTENSION`, which `bootstrapPgvector()` runs first), so
        //    every statement it issues fails with a permission error regardless of whether pgvector
        //    happens to be installed on this server, and regardless of this server's own default
        //    database-level grants -- the acceptance criterion is "role lacks privilege", not
        //    "extension absent", and this exercises exactly that one cause for every statement, not
        //    just the last one.
        await adminPool.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${roleName}"`)
        await adminPool.query(`REVOKE CREATE ON SCHEMA "${schema}" FROM "${roleName}"`)
        await adminPool.query(`REVOKE CREATE ON DATABASE "${parsed.database}" FROM "${roleName}"`)

        restrictedPool = new Pool({
          host: parsed.host ?? undefined,
          port: parsed.port ? Number(parsed.port) : undefined,
          database: parsed.database ?? undefined,
          user: roleName,
          password: rolePassword,
          options: `-c search_path=${schema}`
        })
        const restrictedDb = drizzle({ client: restrictedPool, relations }) as WikiDb

        const result = await bootstrapPgvector(restrictedDb)
        assert.equal(result, false)

        const tableCheck = await db.execute(
          `SELECT 1 FROM information_schema.tables WHERE table_schema = '${schema}' AND table_name = 'pageEmbeddingChunks'`
        )
        assert.equal(tableCheck.rows.length, 0)
      } finally {
        await restrictedPool?.end()
        if (roleCreated) {
          // -> DROP ROLE fails (pg 2BP01) if the role still holds ANY privilege grant anywhere in
          //    the cluster, or owns any object -- not only object ownership, a bare un-revoked GRANT
          //    USAGE ON SCHEMA is enough on its own to block it (verified directly: a role granted
          //    only USAGE, with CREATE revoked and never having created anything, still fails DROP
          //    ROLE with "privileges for schema" in the detail). `DROP OWNED BY` revokes every
          //    privilege grant this role holds and drops anything it owns (including the vector
          //    extension, in the unlikely case some other server configuration still let CREATE
          //    EXTENSION through despite the DATABASE-level revoke above), so it's run
          //    unconditionally before DROP ROLE rather than assuming "this role never succeeded in
          //    creating anything" is enough by itself. Guarded on `roleCreated` since `DROP OWNED
          //    BY` has no `IF EXISTS` form and would itself throw were CREATE ROLE the statement
          //    that failed.
          await adminPool.query(`DROP OWNED BY "${roleName}"`)
        }
        await adminPool.query(`DROP ROLE IF EXISTS "${roleName}"`)
        await adminPool.end()
      }
    }
  )

  test('an unrestricted role gets true back, and the table + HNSW index exist afterward', async (t) => {
    if (skip) {
      t.skip(skip)
      return
    }
    if (!pgvectorAvailable) {
      t.skip('pgvector extension is not installed on this Postgres server')
      return
    }

    const { db, schema } = fixtures

    const result = await bootstrapPgvector(db)
    assert.equal(result, true)

    const tableCheck = await db.execute(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = '${schema}' AND table_name = 'pageEmbeddingChunks'`
    )
    assert.equal(tableCheck.rows.length, 1)

    const indexCheck = await db.execute(
      `SELECT 1 FROM pg_indexes WHERE schemaname = '${schema}' AND indexname = 'pageEmbeddingChunks_embedding_idx'`
    )
    assert.equal(indexCheck.rows.length, 1)

    // -> Idempotent re-run: a second call (a clustered boot's second instance, or this suite's
    //    own concurrent-safety expectation) must not throw on the already-existing objects.
    const secondResult = await bootstrapPgvector(db)
    assert.equal(secondResult, true)
  })
})
