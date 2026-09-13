import { sql } from 'drizzle-orm'
import { filterVisible } from '../modules/search/shared.ts'
import type { AccessActor } from './groups.ts'
import type { VisibilityRef } from '../modules/search/shared.ts'

/**
 * Semantic (embedding-similarity) search, backed directly by Postgres/pgvector — see
 * `docs/superpowers/specs/2026-09-13-semantic-vector-search-design.md` (Epic #3050) for the full
 * design. This file is built up across three Tasks under Feature #3092, each adding its own
 * exported piece rather than editing a shared class body, so the three land as close to a
 * concatenation as a single new file can:
 *
 * - #3099 (this Task): `SEMANTIC_SCAN_CAP` and `annSearch`, the hop-1 ANN-search-plus-`filterVisible`
 *   primitive, plus the `semanticSearch` object registered onto `WIKI.models` below.
 * - #3100: hop-2 seed selection and the second `annSearch` call off a seed chunk's own embedding.
 * - #3101: `search(query, actor, siteId, locale, { limit, offset })`, the merge/dedupe/penalty/
 *   paginate step and the one entry point `api/pages/read.ts` (#3102) wraps.
 *
 * `pageEmbeddingChunks` is deliberately **not** declared in `db/schema.ts` / managed by
 * `drizzle-kit generate` — pgvector is an optional extension (not every host permits installing it),
 * and graceful degradation means its absence must never fail a migration or block boot. `core/db.ts`
 * (#3095) creates the extension and this table imperatively, in a try/catch, after the normal
 * migrations run, and records success as the `WIKI.capabilities.semanticSearch` boot-time flag. This
 * model reads the table through a raw `sql` template rather than the schema-DSL query builder for
 * exactly that reason — it isn't part of the generated schema. See `docs/variances.md` for the
 * recorded exception to the "all schema changes go through `db/schema.ts`" rule.
 */

/**
 * Overfetch ceiling for one ANN search: how many nearest chunk rows are pulled from postgres before
 * `filterVisible` narrows them down to what the caller may actually read.
 *
 * Named and bounded for the same reason `modules/search/shared.ts#SCAN_CAP` and
 * `modules/search/db/search.ts#OVERFETCH_HARD_CAP` are: page-rule filtering cannot be expressed in
 * the `WHERE`/`ORDER BY` clause a vector index answers, so it has to run per-row in this process
 * afterward — a fixed cap is what stops a reader denied nearly everything from turning one call into
 * an unbounded index scan.
 */
export const SEMANTIC_SCAN_CAP = 50

/** One `pageEmbeddingChunks` row, joined to the `pages` columns `filterVisible` needs to decide it. */
export interface SemanticChunkMatch {
  pageId: string
  chunkIndex: number
  chunkText: string
  /** Cosine distance to the query vector this row was matched against — smaller is closer. */
  distance: number
  path: string
  locale: string
  tags: string[]
  classification: string | null
}

export interface AnnSearchScope {
  siteId: string
  locale: string
  /** Who is asking — see `filterVisible`'s own doc comment for what omitting this means. */
  actor?: AccessActor
}

/** The `pages` columns `filterVisible` needs, out of one raw `annSearch` row. */
function toVisibilityRef(row: SemanticChunkMatch): VisibilityRef {
  return {
    path: row.path,
    locale: row.locale,
    tags: row.tags,
    classification: row.classification
  }
}

/**
 * Serialize a raw embedding vector into pgvector's text input format (e.g. `[0.1,0.2,0.3]`), the
 * shape `::vector` casts from.
 *
 * Validated rather than trusted blindly: `annSearch` hands this straight to postgres as a bound
 * parameter (never string-interpolated into the query itself, so this is not an injection concern),
 * but a `NaN`/`Infinity` slipping in from a broken embedding call would otherwise surface as an
 * opaque postgres cast error far from its real cause.
 */
export function toVectorLiteral(embedding: number[]): string {
  if (embedding.length === 0) {
    throw new Error('embedding vector must not be empty')
  }
  for (const value of embedding) {
    if (!Number.isFinite(value)) {
      throw new Error('embedding vector must contain only finite numbers')
    }
  }
  return `[${embedding.join(',')}]`
}

/**
 * Hop-1 ANN search: given a pre-computed embedding vector, finds the `SEMANTIC_SCAN_CAP` nearest
 * `pageEmbeddingChunks` rows (cosine distance, `<=>`) scoped to one site and locale, joined to
 * `pages` for the `path`/`locale`/`tags`/`classification` `filterVisible` needs, then filters through
 * it unchanged — the same page-permission guarantee full-text search already gives, so semantic
 * search is never a way around page rules.
 *
 * Takes a pre-computed **vector**, never a query string — #3100's hop 2 calls this again with a
 * chunk's own embedding (not new text), and a string-only signature here would force that caller to
 * duplicate this query rather than share it. Embedding the query text itself is `helpers/
 * embeddings.ts#embedText`'s job, one layer up, at `search()` (#3101).
 *
 * Returned rows stay in ascending-distance order (postgres's own `ORDER BY`, which `Array#filter`
 * preserves) — nearest match first, exactly like `filterVisible`'s other callers rely on for their
 * own downstream slicing.
 *
 * No LLM call, no synthesis: this returns raw ranked chunk rows.
 */
export async function annSearch(
  embedding: number[],
  { siteId, locale, actor }: AnnSearchScope
): Promise<SemanticChunkMatch[]> {
  const vectorLiteral = toVectorLiteral(embedding)

  const result = await WIKI.db.execute(sql`
    SELECT
      pec."pageId" AS "pageId",
      pec."chunkIndex" AS "chunkIndex",
      pec."chunkText" AS "chunkText",
      pec.embedding <=> ${vectorLiteral}::vector AS distance,
      p.path AS path,
      p.locale AS locale,
      p.tags AS tags,
      p.classification AS classification
    FROM "pageEmbeddingChunks" pec
    JOIN pages p ON p.id = pec."pageId"
    WHERE p."siteId" = ${siteId} AND p.locale = ${locale}
    ORDER BY pec.embedding <=> ${vectorLiteral}::vector
    LIMIT ${SEMANTIC_SCAN_CAP}
  `)

  const rows = (result.rows as any[]).map((row): SemanticChunkMatch => ({
    pageId: row.pageId as string,
    chunkIndex: row.chunkIndex as number,
    chunkText: row.chunkText as string,
    distance: row.distance as number,
    path: row.path as string,
    locale: row.locale as string,
    tags: (row.tags ?? []) as string[],
    classification: (row.classification as string | null) ?? null
  }))

  return filterVisible(rows, actor, siteId, toVisibilityRef)
}

/**
 * `WIKI.models.semanticSearch` — an object rather than a class, and grown by adding exports above
 * and a key here, so #3100/#3101 each add one line instead of editing a shared class body. Only this
 * Task (#3099, the one that creates the file) touches `models/index.ts`'s registration; #3100/#3101
 * only add exports and a key here.
 */
export const semanticSearch = {
  annSearch
}
