import { sql } from 'drizzle-orm'
import { filterVisible } from '../modules/search/shared.ts'
import type { AccessActor } from './groups.ts'
import type { VisibilityRef } from '../modules/search/shared.ts'

/**
 * Multi-hop semantic (embedding-similarity) retrieval over `pageEmbeddingChunks` — Feature #3092
 * under Epic #3050. See `docs/superpowers/specs/2026-09-13-semantic-vector-search-design.md` for the
 * full design; this file implements its "Multi-hop retrieval algorithm" section.
 *
 * `pageEmbeddingChunks` is deliberately NOT part of the generated Drizzle schema (Task #3095's
 * `core/pgvectorBootstrap.ts` creates it imperatively, gated on `WIKI.capabilities.semanticSearch`,
 * since the `vector` extension it depends on is genuinely optional) — so every query here goes
 * through `WIKI.db.execute(sql\`...\`)` rather than the schema-DSL query builder, exactly as that
 * task's own doc comment anticipates.
 *
 * This file is shared, additive ground between three sibling Tasks of Feature #3092 — each adds its
 * own separately-named export rather than editing another's:
 *   - Task #3099 owns `annSearchByVector`, the ANN-search-plus-`filterVisible` primitive (hop 1).
 *   - Task #3100 (this one) owns `selectHop2Seeds`/`runHop2` — the hop-2 seed selection and second
 *     ANN query, built on #3099's primitive with a different input vector.
 *   - Task #3101 owns the merge/dedupe/penalty/paginate step and the exported `search()` entry point
 *     that embeds the query text, calls both hops, and is what the API route wraps.
 */

/**
 * Ceiling on how many nearest-neighbor chunk rows one ANN query scans before `filterVisible` narrows
 * it to what the actor may actually read — analogous to `modules/search/shared.ts`'s `SCAN_CAP`/
 * `OVERFETCH_HARD_CAP`. Applies identically to hop 1 and every hop-2 seed's own query.
 */
export const SEMANTIC_SCAN_CAP = 50

/** How many distinct hop-1 pages become hop-2 seeds. */
export const HOP2_SEED_COUNT = 3

export interface SemanticSearchScope {
  siteId: string
  locale: string
  /** Who is searching — dropped straight into `filterVisible`, so an absent actor filters nothing
   *  (an internal caller, or a caller that has already filtered). */
  actor?: AccessActor
}

/** One `pageEmbeddingChunks` row, joined to its page, after `filterVisible`. */
export interface SemanticChunkRow {
  chunkId: string
  pageId: string
  chunkText: string
  /** This chunk's own embedding, parsed back out of pgvector's text representation. Hop 2 reads
   *  this straight off a hop-1 seed row and hands it to `annSearchByVector` as the next query
   *  vector — the actual "semantic hop". */
  embedding: number[]
  distance: number
  path: string
  locale: string
  tags: string[]
  classification: string | null
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
 * pgvector's own literal format for a query vector — `'[v0,v1,...]'`. Passed as a normal,
 * parameterized string value (never interpolated as raw SQL) and cast with `::vector` server-side.
 */
function toVectorParam(vector: number[]): string {
  return `[${vector.join(',')}]`
}

/**
 * Task #3099: ANN search — the `SEMANTIC_SCAN_CAP` nearest chunks (cosine distance) to
 * `queryVector`, scoped to one site and locale, filtered down to what `scope.actor` may read via
 * `read:pages` (`filterVisible`, unchanged and reused directly — not reimplemented — so semantic
 * search carries the exact same permission guarantee full-text search already gives).
 *
 * Takes a pre-computed embedding VECTOR, never a query string or page id — this is the one
 * primitive both hop 1 and hop 2 (`runHop2` below) call, with different input vectors. Hop 2 must
 * never duplicate this ANN-plus-`filterVisible` logic; it re-calls this function with a chunk's own
 * embedding instead of the original query's.
 */
export async function annSearchByVector(
  queryVector: number[],
  scope: SemanticSearchScope
): Promise<SemanticChunkRow[]> {
  const vectorParam = toVectorParam(queryVector)
  const result = await WIKI.db.execute(sql`
    SELECT
      pec."id" AS "chunkId",
      pec."pageId" AS "pageId",
      pec."chunkText" AS "chunkText",
      pec."embedding" AS "embedding",
      (pec."embedding" <=> ${vectorParam}::vector) AS "distance",
      p."path" AS "path",
      p."locale" AS "locale",
      p."tags" AS "tags",
      p."classification" AS "classification"
    FROM "pageEmbeddingChunks" pec
    JOIN pages p ON p."id" = pec."pageId"
    WHERE p."siteId" = ${scope.siteId} AND p."locale" = ${scope.locale}
    ORDER BY pec."embedding" <=> ${vectorParam}::vector
    LIMIT ${SEMANTIC_SCAN_CAP}
  `)

  const rows: SemanticChunkRow[] = (result.rows as any[]).map((row) => ({
    chunkId: row.chunkId as string,
    pageId: row.pageId as string,
    chunkText: row.chunkText as string,
    embedding: parseVector(row.embedding),
    distance: Number(row.distance),
    path: row.path as string,
    locale: row.locale as string,
    tags: (row.tags ?? []) as string[],
    classification: (row.classification as string | null) ?? null
  }))

  return filterVisible(rows, scope.actor, scope.siteId, (row): VisibilityRef => ({
    path: row.path,
    locale: row.locale,
    tags: row.tags,
    classification: row.classification
  }))
}

/**
 * Task #3100: the top `HOP2_SEED_COUNT` distinct pages from hop 1's visible results, each
 * represented by its own single best (lowest-distance) chunk — a page can contribute more than one
 * chunk to hop 1's results, and only its best one seeds hop 2.
 *
 * Returns fewer than `HOP2_SEED_COUNT` seeds when hop 1 itself surfaced fewer distinct pages; never
 * throws or pads.
 */
export function selectHop2Seeds(hop1Visible: SemanticChunkRow[]): SemanticChunkRow[] {
  const bestPerPage = new Map<string, SemanticChunkRow>()
  for (const row of hop1Visible) {
    const existing = bestPerPage.get(row.pageId)
    if (!existing || row.distance < existing.distance) {
      bestPerPage.set(row.pageId, row)
    }
  }
  return [...bestPerPage.values()].sort((a, b) => a.distance - b.distance).slice(0, HOP2_SEED_COUNT)
}

/**
 * Task #3100: the actual semantic hop. For each of up to `HOP2_SEED_COUNT` hop-1 seed pages
 * (`selectHop2Seeds`), re-runs `annSearchByVector` using that seed's own best chunk's embedding as
 * the query vector — instead of the original query text/vector — moving from "what matches the
 * literal query" to "what matches the meaning of the best thing the literal query already found".
 *
 * One `annSearchByVector` call per seed, so each seed's own results are independently
 * `SEMANTIC_SCAN_CAP`-bounded and `filterVisible`-checked exactly like hop 1. Results across seeds
 * are pooled here, not deduped, penalized or ranked — a page reachable via more than one seed, or
 * via both hop 1 and hop 2, appears more than once in this return value on purpose; merge/dedupe/
 * penalty/rank across hop 1 and hop 2 is Task #3101's `search()` entry point, which is also where
 * the "a page in both hops reports hop: 1 with its unpenalized hop-1 distance" rule is applied.
 */
export async function runHop2(
  hop1Visible: SemanticChunkRow[],
  scope: SemanticSearchScope
): Promise<SemanticChunkRow[]> {
  const seeds = selectHop2Seeds(hop1Visible)
  const hop2Batches = await Promise.all(
    seeds.map((seed) => annSearchByVector(seed.embedding, scope))
  )
  return hop2Batches.flat()
}
