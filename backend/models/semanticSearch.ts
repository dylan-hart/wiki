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
 * - #3099: `SEMANTIC_SCAN_CAP` and `annSearch`, the hop-1 ANN-search-plus-`filterVisible`
 *   primitive, plus the `semanticSearch` object registered onto `WIKI.models` below.
 * - #3100 (this Task): `HOP2_SEED_COUNT`, `selectHop2Seeds` and `runHop2` — hop-2 seed selection
 *   and the second `annSearch` call off a seed chunk's own embedding, reusing `annSearch` itself
 *   unchanged rather than re-deriving its ANN-plus-`filterVisible` logic with a different input
 *   vector.
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
 * an unbounded index scan. Applies identically to hop 1 and every hop-2 seed's own query.
 */
export const SEMANTIC_SCAN_CAP = 50

/** How many distinct hop-1 pages become hop-2 seeds. */
export const HOP2_SEED_COUNT = 3

/** One `pageEmbeddingChunks` row, joined to the `pages` columns `filterVisible` needs to decide it. */
export interface SemanticChunkMatch {
  pageId: string
  chunkIndex: number
  chunkText: string
  /** This chunk's own embedding, parsed back out of pgvector's text representation. Hop 2
   *  (`runHop2`) reads this straight off a hop-1 seed row and hands it to `annSearch` as the next
   *  query vector — the actual "semantic hop". */
  embedding: number[]
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

/** Parses pgvector's `'[0.1,0.2,...]'` text representation back into a plain number array. Accepts
 *  an already-decoded array too, since a driver-level type parser could plausibly do that itself. */
function parseVector(raw: unknown): number[] {
  if (Array.isArray(raw)) {
    return raw as number[]
  }
  const text = String(raw)
  return text
    .slice(1, -1)
    .split(',')
    .filter((part) => part.length > 0)
    .map(Number)
}

/**
 * Hop-1 ANN search: given a pre-computed embedding vector, finds the `SEMANTIC_SCAN_CAP` nearest
 * `pageEmbeddingChunks` rows (cosine distance, `<=>`) scoped to one site and locale, joined to
 * `pages` for the `path`/`locale`/`tags`/`classification` `filterVisible` needs, then filters through
 * it unchanged — the same page-permission guarantee full-text search already gives, so semantic
 * search is never a way around page rules.
 *
 * Takes a pre-computed **vector**, never a query string — #3100's `runHop2` calls this again with a
 * seed chunk's own embedding (not new text), and a string-only signature here would force that
 * caller to duplicate this query rather than share it. Embedding the query text itself is `helpers/
 * embeddings.ts#embedText`'s job, one layer up, at `search()` (#3101).
 *
 * Returned rows carry their own `embedding` (parsed back out of pgvector's text representation) so a
 * caller can re-query with it, and stay in ascending-distance order (postgres's own `ORDER BY`, which
 * `Array#filter` preserves) — nearest match first, exactly like `filterVisible`'s other callers rely
 * on for their own downstream slicing.
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
      pec."embedding" AS "embedding",
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
    embedding: parseVector(row.embedding),
    distance: Number(row.distance),
    path: row.path as string,
    locale: row.locale as string,
    tags: (row.tags ?? []) as string[],
    classification: (row.classification as string | null) ?? null
  }))

  return filterVisible(rows, actor, siteId, toVisibilityRef)
}

/**
 * #3100: the top `HOP2_SEED_COUNT` distinct pages from hop 1's visible results, each represented by
 * its own single best (lowest-distance) chunk — a page can contribute more than one chunk to hop
 * 1's results, and only its best one seeds hop 2.
 *
 * Returns fewer than `HOP2_SEED_COUNT` seeds when hop 1 itself surfaced fewer distinct pages; never
 * throws or pads.
 */
export function selectHop2Seeds(hop1Visible: SemanticChunkMatch[]): SemanticChunkMatch[] {
  const bestPerPage = new Map<string, SemanticChunkMatch>()
  for (const row of hop1Visible) {
    const existing = bestPerPage.get(row.pageId)
    if (!existing || row.distance < existing.distance) {
      bestPerPage.set(row.pageId, row)
    }
  }
  return [...bestPerPage.values()].sort((a, b) => a.distance - b.distance).slice(0, HOP2_SEED_COUNT)
}

/**
 * #3100: the actual semantic hop. For each of up to `HOP2_SEED_COUNT` hop-1 seed pages
 * (`selectHop2Seeds`), re-runs `annSearch` using that seed's own best chunk's embedding as the query
 * vector — instead of the original query text/vector — moving from "what matches the literal query"
 * to "what matches the meaning of the best thing the literal query already found".
 *
 * One `annSearch` call per seed, so each seed's own results are independently
 * `SEMANTIC_SCAN_CAP`-bounded and `filterVisible`-checked exactly like hop 1. Results across seeds
 * are pooled here, not deduped, penalized or ranked — a page reachable via more than one seed, or
 * via both hop 1 and hop 2, appears more than once in this return value on purpose; merge/dedupe/
 * penalty/rank across hop 1 and hop 2 is Task #3101's `search()` entry point, which is also where
 * the "a page in both hops reports hop: 1 with its unpenalized hop-1 distance" rule is applied.
 */
export async function runHop2(
  hop1Visible: SemanticChunkMatch[],
  scope: AnnSearchScope
): Promise<SemanticChunkMatch[]> {
  const seeds = selectHop2Seeds(hop1Visible)
  const hop2Batches = await Promise.all(seeds.map((seed) => annSearch(seed.embedding, scope)))
  return hop2Batches.flat()
}

/**
 * `WIKI.models.semanticSearch` — an object rather than a class, and grown by adding exports above
 * and a key here, so #3101 adds one more line instead of editing a shared class body. Only Task
 * #3099 (the one that created the file) touched `models/index.ts`'s registration; #3100/#3101 only
 * add exports and a key here.
 */
export const semanticSearch = {
  annSearch,
  selectHop2Seeds,
  runHop2
}
