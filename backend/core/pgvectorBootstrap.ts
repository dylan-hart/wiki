import type { WikiDb } from './db.ts'

/**
 * Optional, unlike `core/db.ts`'s `REQUIRED_EXTENSIONS`: a host whose role lacks `CREATE EXTENSION`
 * privilege, or whose Postgres has no pgvector, must boot as it would without this module. So this
 * never throws -- any failure is logged at `warn` and answered with `false`.
 *
 * Raw SQL rather than a `db/schema.ts` table plus a generated migration: a Drizzle migration has no
 * "skip this DDL if it fails" affordance, and a failed one blocks every later boot.
 *
 * Every statement is `IF NOT EXISTS`, and `core/db.ts#syncSchemas()` calls this under the advisory
 * lock it already holds, so instances booting at once serialize rather than race.
 */
export async function bootstrapPgvector(db: WikiDb): Promise<boolean> {
  try {
    await db.execute('CREATE EXTENSION IF NOT EXISTS vector')

    // -> Schema-unqualified on purpose, `pages` included: the connection's `search_path` (set from
    //    `CARDINAL.config.db.schema`) resolves it, as it does for the Drizzle-generated migrations.
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

    await db.execute(`
      CREATE TABLE IF NOT EXISTS "assetEmbeddingChunks" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "assetId" uuid NOT NULL REFERENCES "assets"("id") ON DELETE CASCADE,
        "chunkIndex" integer NOT NULL,
        "chunkText" text NOT NULL,
        "embedding" vector(384),
        "updatedAt" timestamp with time zone DEFAULT now() NOT NULL
      )
    `)

    await db.execute(`
      CREATE INDEX IF NOT EXISTS "assetEmbeddingChunks_embedding_idx"
      ON "assetEmbeddingChunks"
      USING hnsw ("embedding" vector_cosine_ops)
    `)

    await db.execute(`
      CREATE INDEX IF NOT EXISTS "assetEmbeddingChunks_assetId_idx"
      ON "assetEmbeddingChunks" ("assetId")
    `)

    CARDINAL.logger.info('db', 'pgvector capability enabled', {
      tables: 'pageEmbeddingChunks,assetEmbeddingChunks'
    })
    return true
  } catch (err: any) {
    CARDINAL.logger.warn('db', 'pgvector capability unavailable, semantic search disabled', {
      error: err
    })
    return false
  }
}
