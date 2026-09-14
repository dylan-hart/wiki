import type { WikiDb } from './db.ts'

/**
 * Attempts to enable the optional pgvector-backed semantic-search capability: the `vector`
 * extension, the `pageEmbeddingChunks` table, and its HNSW cosine-distance index.
 *
 * Deliberately separate from `core/db.ts`'s `REQUIRED_EXTENSIONS` loop (`syncSchemas()`), which is a
 * different, required-or-boot-fails mechanism -- `ltree`/`pg_trgm`/`pgcrypto` are load-bearing for
 * the migrations that follow them and a missing one is a genuine boot failure. pgvector is not: a
 * locked-down host whose role lacks `CREATE EXTENSION` privilege, or whose Postgres build has no
 * pgvector installed at all, boots exactly as it would without this module. This function therefore
 * never throws -- any failure (missing extension, insufficient privilege, anything else) is caught
 * and logged at `warn`, and the caller reads the boolean return to know whether the capability came
 * up.
 *
 * Deliberately raw SQL rather than a `db/schema.ts` table plus a `drizzle-kit generate` migration:
 * `pageEmbeddingChunks`'s existence is conditional on an extension the operator may not be permitted
 * to install, and a Drizzle migration has no "skip this DDL if it fails" affordance -- a failed
 * migration leaves the migration ledger in a state every later boot refuses to run past. See
 * `docs/decisions/pgvector-raw-sql-table.md` for the full reasoning.
 *
 * Every statement is `IF NOT EXISTS`, so a repeated call (this module's own DB-backed test calls it
 * more than once, and a clustered boot could race another instance running the same statements) is
 * safe to re-run. `core/db.ts#syncSchemas()` calls this under the same session-scoped advisory lock
 * it already holds across `CREATE SCHEMA`/`CREATE EXTENSION`/`migrate()`, so two instances booting
 * cold at once still serialize through it rather than racing.
 *
 * @returns `true` once the extension, table and index all exist; `false` if any step failed.
 */
export async function bootstrapPgvector(db: WikiDb): Promise<boolean> {
  try {
    await db.execute('CREATE EXTENSION IF NOT EXISTS vector')

    // -> Schema-unqualified, matching every other DDL statement `syncSchemas()` runs: the connection's
    //    `search_path` (set from `WIKI.config.db.schema` when the pool is built) is what resolves
    //    this to the right schema, the same way the Drizzle-generated migrations do. `pages` is
    //    likewise unqualified for the same reason -- see `db/schema.ts#pages`.
    await db.execute(`
      CREATE TABLE IF NOT EXISTS "pageEmbeddingChunks" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "pageId" uuid NOT NULL REFERENCES "pages"("id") ON DELETE CASCADE,
        "chunkIndex" integer NOT NULL,
        "chunkText" text NOT NULL,
        "embedding" vector(384),
        "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
      )
    `)

    await db.execute(`
      CREATE INDEX IF NOT EXISTS "pageEmbeddingChunks_embedding_idx"
      ON "pageEmbeddingChunks"
      USING hnsw ("embedding" vector_cosine_ops)
    `)

    WIKI.logger.info('db', 'pgvector capability enabled', { table: 'pageEmbeddingChunks' })
    return true
  } catch (err: any) {
    WIKI.logger.warn('db', 'pgvector capability unavailable, semantic search disabled', {
      error: err
    })
    return false
  }
}
