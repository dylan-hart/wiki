import { sql } from 'drizzle-orm'
import { embedText } from '../helpers/embeddings.ts'
import { filterVisible } from '../modules/search/shared.ts'
import type { AccessActor } from './groups.ts'
import type { VisibilityRef } from '../modules/search/shared.ts'
import type { SearchPagesResult } from './search.ts'

/**
 * Semantic (embedding-similarity) search, backed directly by Postgres/pgvector — see
 * `docs/superpowers/specs/2026-09-13-semantic-vector-search-design.md` (Epic #3050) for the full
 * design. This file is built up across three Tasks under Feature #3092, each adding its own
 * exported piece rather than editing a shared class body, so the three land as close to a
 * concatenation as a single new file can:
 *
 * - #3099: `SEMANTIC_SCAN_CAP` and `annSearch`, the hop-1 ANN-search-plus-`filterVisible`
 *   primitive, plus the `semanticSearch` object registered onto `CARDINAL.models` below.
 * - #3100: `HOP2_SEED_COUNT`, `selectHop2Seeds` and `runHop2` — hop-2 seed selection and the
 *   second `annSearch` call off a seed chunk's own embedding, reusing `annSearch` itself
 *   unchanged rather than re-deriving its ANN-plus-`filterVisible` logic with a different input
 *   vector.
 * - #3101 (this Task): `bestChunkPerPage`, `dedupeAndRank`, `mergeHopResults` and the
 *   `search(query, actor, siteId, locale, { limit, offset })` entry point that
 *   `api/pages/read.ts` (#3102) wraps — merge/dedupe/penalty/rank plus pagination on top of
 *   `annSearch`/`runHop2`'s already-filtered output. Because `annSearch`/`runHop2` return only
 *   the *visible* rows for their hop, `totalHitsApproximate` (which needs to know whether
 *   permission filtering actually dropped a scanned row) is computed off `queryChunks`, the same
 *   private, unfiltered ANN primitive `annSearch` itself is built on — see `hop1Outcome`/
 *   `hop2Outcome` below. This keeps `annSearch`'s and `runHop2`'s own public contracts (and their
 *   #3099/#3100 test coverage) unchanged while giving `search()` the scanned-vs-visible counts it
 *   needs, with one DB round trip per hop either way.
 *
 * `pageEmbeddingChunks` is deliberately **not** declared in `db/schema.ts` / managed by
 * `drizzle-kit generate` — pgvector is an optional extension (not every host permits installing it),
 * and graceful degradation means its absence must never fail a migration or block boot. `core/db.ts`
 * (#3095) creates the extension and this table imperatively, in a try/catch, after the normal
 * migrations run, and records success as the `CARDINAL.capabilities.semanticSearch` boot-time flag. This
 * model reads the table through a raw `sql` template rather than the schema-DSL query builder for
 * exactly that reason — it isn't part of the generated schema, a deliberate exception to the "all
 * schema changes go through `db/schema.ts`" rule.
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

/**
 * Added to a hop-2-ONLY page's distance before ranking, so a genuine direct (hop-1) match always
 * outranks an equally-distant hop-2-only one — reflecting that it really is one step further
 * removed. A named, tunable constant rather than a magic number.
 */
export const HOP2_DISTANCE_PENALTY = 0.1

/** One `pageEmbeddingChunks` row, joined to the `pages` columns `filterVisible` and the merged
 *  result shape need to decide/display it. */
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
  title: string
  description: string | null
  icon: string | null
  tags: string[]
  classification: string | null
}

/** One hop's raw scan alongside what survived `filterVisible` — what `search()` needs to compute
 *  `totalHitsApproximate` per the design doc's "whenever permission filtering actually dropped a
 *  row the ANN search had counted" rule. Not part of `annSearch`/`runHop2`'s own public contract;
 *  see `hop1Outcome`/`hop2Outcome`. */
export interface HopOutcome {
  scanned: SemanticChunkMatch[]
  visible: SemanticChunkMatch[]
}

/**
 * `SearchPagesResult`, but with `results` shaped as `SemanticSearchResult[]` (carrying `hop`) rather
 * than the full-text engines' own `SearchResult[]` — the same envelope, a different row shape.
 */
export type SemanticSearchPagesResult = Omit<SearchPagesResult, 'results'> & {
  results: SemanticSearchResult[]
}

/** A merged, deduped, ranked result — one row per page, with the hop it was ultimately attributed to. */
export interface SemanticSearchResult {
  pageId: string
  path: string
  locale: string
  title: string
  description: string | null
  icon: string | null
  chunkText: string
  chunkIndex: number
  /** The real, unpenalized distance — a page that appeared in both hops keeps its hop-1 value. */
  distance: number
  /** `2` only when the page was hop-2-ONLY; a page appearing in both hops reports `1`. */
  hop: 1 | 2
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
 * The raw ANN query shared by `annSearch` and, for the scanned-count `search()` needs, by
 * `hop1Outcome`/`hop2Outcome` below: nearest `SEMANTIC_SCAN_CAP` `pageEmbeddingChunks` rows (cosine
 * distance, `<=>`) scoped to one site and locale, joined to `pages` for the columns `filterVisible`
 * and the merged result shape need. No permission filtering here — that is every caller's own job,
 * so a caller that needs the pre-filter scan count (for `totalHitsApproximate`) can still get it.
 *
 * Returned rows carry their own `embedding` (parsed back out of pgvector's text representation) so a
 * caller can re-query with it, and stay in ascending-distance order (postgres's own `ORDER BY`) —
 * nearest match first.
 */
async function queryChunks(
  embedding: number[],
  siteId: string,
  locale: string
): Promise<SemanticChunkMatch[]> {
  const vectorLiteral = toVectorLiteral(embedding)

  const result = await CARDINAL.db.execute(sql`
    SELECT
      pec."pageId" AS "pageId",
      pec."chunkIndex" AS "chunkIndex",
      pec."chunkText" AS "chunkText",
      pec."embedding" AS "embedding",
      pec.embedding <=> ${vectorLiteral}::vector AS distance,
      p.path AS path,
      p.locale AS locale,
      p.title AS title,
      p.description AS description,
      p.icon AS icon,
      p.tags AS tags,
      p.classification AS classification
    FROM "pageEmbeddingChunks" pec
    JOIN pages p ON p.id = pec."pageId"
    WHERE p."siteId" = ${siteId} AND p.locale = ${locale}
    ORDER BY pec.embedding <=> ${vectorLiteral}::vector
    LIMIT ${SEMANTIC_SCAN_CAP}
  `)

  return (result.rows as any[]).map((row): SemanticChunkMatch => ({
    pageId: row.pageId as string,
    chunkIndex: row.chunkIndex as number,
    chunkText: row.chunkText as string,
    embedding: parseVector(row.embedding),
    distance: Number(row.distance),
    path: row.path as string,
    locale: row.locale as string,
    title: row.title as string,
    description: (row.description as string | null) ?? null,
    icon: (row.icon as string | null) ?? null,
    tags: (row.tags ?? []) as string[],
    classification: (row.classification as string | null) ?? null
  }))
}

/**
 * Hop-1 ANN search: given a pre-computed embedding vector, finds the `SEMANTIC_SCAN_CAP` nearest
 * `pageEmbeddingChunks` rows scoped to one site and locale, then filters through `filterVisible`
 * unchanged — the same page-permission guarantee full-text search already gives, so semantic
 * search is never a way around page rules.
 *
 * Takes a pre-computed **vector**, never a query string — #3100's `runHop2` calls this again with a
 * seed chunk's own embedding (not new text), and a string-only signature here would force that
 * caller to duplicate this query rather than share it. Embedding the query text itself is `helpers/
 * embeddings.ts#embedText`'s job, one layer up, at `search()` (#3101).
 *
 * No LLM call, no synthesis: this returns raw ranked chunk rows.
 */
export async function annSearch(
  embedding: number[],
  { siteId, locale, actor }: AnnSearchScope
): Promise<SemanticChunkMatch[]> {
  const rows = await queryChunks(embedding, siteId, locale)
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
export function selectHop2Seeds(
  hop1Visible: SemanticChunkMatch[],
  count = HOP2_SEED_COUNT
): SemanticChunkMatch[] {
  return [...bestChunkPerPage(hop1Visible).values()]
    .sort((a, b) => a.distance - b.distance)
    .slice(0, count)
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
 * penalty/rank across hop 1 and hop 2 is `dedupeAndRank`/`mergeHopResults` below, which is also
 * where the "a page in both hops reports hop: 1 with its unpenalized hop-1 distance" rule is
 * applied.
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
 * Hop 1, scanned-and-visible: `queryChunks` plus `filterVisible`, kept apart from the public
 * `annSearch` purely so `search()` can see how many rows were scanned before filtering (for
 * `totalHitsApproximate`) without changing `annSearch`'s own return shape or its #3099 test
 * coverage.
 */
async function hop1Outcome(
  queryVector: number[],
  { siteId, locale, actor }: AnnSearchScope
): Promise<HopOutcome> {
  const scanned = await queryChunks(queryVector, siteId, locale)
  const visible = filterVisible(scanned, actor, siteId, toVisibilityRef)
  return { scanned, visible }
}

/**
 * Hop 2, scanned-and-visible: one `queryChunks` call per seed (mirroring `runHop2`'s own one
 * `annSearch` call per seed), pooled before `filterVisible` runs once over the whole pool — same
 * reasoning as `hop1Outcome`, kept apart from the public `runHop2` so its own #3100 test coverage
 * (a flat, visible-only array) stays unchanged.
 */
async function hop2Outcome(
  seeds: SemanticChunkMatch[],
  { siteId, locale, actor }: AnnSearchScope
): Promise<HopOutcome> {
  const scannedBatches = await Promise.all(
    seeds.map((seed) => queryChunks(seed.embedding, siteId, locale))
  )
  const scanned = scannedBatches.flat()
  const visible = filterVisible(scanned, actor, siteId, toVisibilityRef)
  return { scanned, visible }
}

/**
 * One page's own best (lowest-distance) chunk, out of a flat list of chunk rows that may hold
 * several rows per page.
 *
 * Pure — shared by `selectHop2Seeds` (dedupe hop 1's visible rows down to one candidate per page
 * before picking seeds) and `dedupeAndRank` (the same reduction, once per hop, before merging).
 */
export function bestChunkPerPage(rows: SemanticChunkMatch[]): Map<string, SemanticChunkMatch> {
  const best = new Map<string, SemanticChunkMatch>()
  for (const row of rows) {
    const existing = best.get(row.pageId)
    if (!existing || row.distance < existing.distance) {
      best.set(row.pageId, row)
    }
  }
  return best
}

function toSemanticSearchResult(match: SemanticChunkMatch): Omit<SemanticSearchResult, 'hop'> {
  return {
    pageId: match.pageId,
    path: match.path,
    locale: match.locale,
    title: match.title,
    description: match.description,
    icon: match.icon,
    chunkText: match.chunkText,
    chunkIndex: match.chunkIndex,
    distance: match.distance
  }
}

/**
 * Pool hop 1's and hop 2's visible results, dedupe to one row per page, and rank.
 *
 * A page with any hop-1 chunk uses its best hop-1 chunk and its real, unpenalized distance,
 * reporting `hop: 1` — regardless of whether it also turned up in hop 2 (its hop-2 rows are simply
 * ignored). A page with chunks in hop 2 ONLY uses its best hop-2 chunk, with `HOP2_DISTANCE_PENALTY`
 * added before sorting, reporting `hop: 2`. Sorted by the (possibly penalized) distance ascending.
 *
 * Pure — no `CARDINAL` global, no database — the function `semanticSearch.test.ts` targets directly.
 */
export function dedupeAndRank(
  hop1Visible: SemanticChunkMatch[],
  hop2Visible: SemanticChunkMatch[]
): SemanticSearchResult[] {
  const hop1Best = bestChunkPerPage(hop1Visible)
  const hop2Best = bestChunkPerPage(hop2Visible)

  const ranked: (SemanticSearchResult & { rankDistance: number })[] = []
  for (const match of hop1Best.values()) {
    ranked.push({ ...toSemanticSearchResult(match), hop: 1, rankDistance: match.distance })
  }
  for (const [pageId, match] of hop2Best) {
    if (hop1Best.has(pageId)) {
      continue
    }
    ranked.push({
      ...toSemanticSearchResult(match),
      hop: 2,
      rankDistance: match.distance + HOP2_DISTANCE_PENALTY
    })
  }

  ranked.sort((a, b) => a.rankDistance - b.rankDistance)
  return ranked.map(({ rankDistance: _rankDistance, ...rest }) => rest)
}

/**
 * `dedupeAndRank` plus pagination and the `totalHits`/`totalHitsApproximate` counts, computed the
 * same way `modules/search/shared.ts#toSearchPagesResult` computes them: `totalHits` is the size of
 * the (deduped, page-level) visible set, and `totalHitsApproximate` is `true` whenever either hop's
 * own overfetched scan count differs from its post-`filterVisible` count — i.e. whenever permission
 * filtering actually dropped a chunk row that had been scanned, at either hop.
 *
 * Pure — no `CARDINAL`, no database.
 */
export function mergeHopResults(
  hop1Result: HopOutcome,
  hop2Result: HopOutcome,
  { offset, limit }: { offset: number; limit: number }
): SemanticSearchPagesResult {
  const merged = dedupeAndRank(hop1Result.visible, hop2Result.visible)
  const totalScanned = hop1Result.scanned.length + hop2Result.scanned.length
  const totalVisible = hop1Result.visible.length + hop2Result.visible.length
  return {
    results: merged.slice(offset, offset + limit),
    totalHits: merged.length,
    totalHitsApproximate: totalScanned !== totalVisible,
    suggestion: null
  }
}

const EMPTY_HOP_OUTCOME: HopOutcome = { scanned: [], visible: [] }

/**
 * The Feature's public entry point: embed `query`, run both hops, merge/rank/dedupe/paginate.
 *
 * `CARDINAL.models.semanticSearch.search(...)` is what `api/pages/read.ts`'s semantic search route
 * (#3102) wraps. Degrades to an empty, non-approximate result set when local embedding inference is
 * unavailable (`embedText` returns `null`) — the same "hide rather than fail" posture
 * `CARDINAL.capabilities.semanticSearch` gives the rest of this feature (design doc's scope decision 8).
 */
export async function search(
  query: string,
  actor: AccessActor | undefined,
  siteId: string,
  locale: string,
  { limit, offset }: { limit: number; offset: number }
): Promise<SemanticSearchPagesResult> {
  const queryVector = await embedText(query)
  if (!queryVector) {
    return { results: [], totalHits: 0, totalHitsApproximate: false, suggestion: null }
  }

  const scope: AnnSearchScope = { siteId, locale, actor }
  const hop1Result = await hop1Outcome(queryVector, scope)
  const seeds = selectHop2Seeds(hop1Result.visible)
  const hop2Result = seeds.length > 0 ? await hop2Outcome(seeds, scope) : EMPTY_HOP_OUTCOME

  return mergeHopResults(hop1Result, hop2Result, { offset, limit })
}

/**
 * `CARDINAL.models.semanticSearch` — an object rather than a class, and grown by adding exports above
 * and a key here, so each Task adds one more line instead of editing a shared class body. Only Task
 * #3099 (the one that created the file) touched `models/index.ts`'s registration.
 */
export const semanticSearch = {
  annSearch,
  selectHop2Seeds,
  runHop2,
  bestChunkPerPage,
  dedupeAndRank,
  mergeHopResults,
  search
}
