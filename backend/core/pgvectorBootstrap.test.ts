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
 * Real Postgres roles and privileges rather than a mocked `db.execute`: the negative case is a
 * genuine permission denial from the server, and a mock would only prove that the code calls
 * `catch`, not that it survives the shape a real `CREATE EXTENSION`/`CREATE TABLE` failure takes.
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
        // -> USAGE only. CREATE is withheld on the schema (gates `CREATE TABLE`) and on the
        //    database (gates `CREATE EXTENSION`, which runs first), so every statement fails on
        //    privilege whether or not pgvector is installed on this server.
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
          // -> DROP ROLE fails (pg 2BP01) while the role holds any privilege grant, and a bare
          //    GRANT USAGE ON SCHEMA is enough. `DROP OWNED BY` revokes them all and drops anything
          //    the role owns. Guarded on `roleCreated` because it has no `IF EXISTS` form.
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

    // -> A second call (a clustered boot's second instance) must not throw on the existing objects.
    const secondResult = await bootstrapPgvector(db)
    assert.equal(secondResult, true)
  })
})
