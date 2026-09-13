import { sql } from 'drizzle-orm'
import { embedText } from '../helpers/embeddings.ts'
import { filterVisible } from '../modules/search/shared.ts'
import type { AccessActor } from './groups.ts'
import type { SearchPagesResult } from './search.ts'

/**
 * Semantic (embedding-similarity) search — hop-1/hop-2 ANN retrieval over `pageEmbeddingChunks`,
 * merge/dedupe/penalty/rank, pagination, and the public `search()` entry point.
 *
 * Design: `docs/superpowers/specs/2026-09-13-semantic-vector-search-design.md` (Epic #3050).
 * Feature #3092 ("Multi-hop semantic retrieval logic") split this file across three Tasks that all
 * extend it: #3099 (hop 1: `annSearch`/`hop1`), #3100 (hop 2 seed selection + query: `selectHop2Seeds`/
 * `hop2`), #3101 (this Task's own scope: `bestChunkPerPage`, `dedupeAndRank`, `mergeHopResults` and
 * the `search()` entry point that ties all three together). Ground truth at the time this Task was
 * implemented: neither #3099 nor #3100 had landed anywhere yet, so hop 1/hop 2 below are this Task's
 * own best-effort implementation against the documented contract (Epic #3050 round-2 coordination
 * note's "Contract-only deps (stub, don't block)"), expected to be reconciled with #3099's/#3100's
 * real versions at integration. The genuinely owned, fully-tested deliverable is the pure merge
 * logic — see `semanticSearch.test.ts`.
 *
 * `pageEmbeddingChunks` is managed imperatively at boot (design doc's "Schema & pgvector
 * availability"), not through `db/schema.ts` / `drizzle-kit generate`, so every query against it here
 * goes through `WIKI.db.execute(sql\`...\`)` rather than the Drizzle query builder.
 */

/**
 * Rows an ANN pass scans (per hop) before `filterVisible` narrows them, analogous to
 * `modules/search/shared.ts`'s `SCAN_CAP`/`OVERFETCH_HARD_CAP`.
 */
export const SEMANTIC_SCAN_CAP = 50

/** How many distinct hop-1 pages seed the hop-2 query. */
export const HOP2_SEED_COUNT = 3

/**
 * Added to a hop-2-ONLY page's distance before ranking, so a genuine direct (hop-1) match always
 * outranks an equally-distant hop-2-only one — reflecting that it really is one step further
 * removed. A named, tunable constant rather than a magic number.
 */
export const HOP2_DISTANCE_PENALTY = 0.1

/** One chunk row, joined to its page's visibility-relevant columns, as either hop returns it. */
export interface SemanticChunkMatch {
  pageId: string
  path: string
  locale: string
  title: string
  description: string | null
  icon: string | null
  tags: string[]
  classification: string | null
  chunkText: string
  chunkIndex: number
  distance: number
  /** This chunk's own embedding — what a hop-2 seed's query vector is drawn from. */
  embedding: number[]
}

/** One hop's raw scan alongside what survived `filterVisible`, the shape both hops return. */
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

/** The `VisibilityRef` shape `filterVisible` needs, read off a `SemanticChunkMatch`. */
function toVisibilityRef(row: SemanticChunkMatch) {
  return { path: row.path, locale: row.locale, tags: row.tags, classification: row.classification }
}

/** A pgvector `::vector` text literal, e.g. `[0.1,0.2,0.3]`. */
function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`
}

/** The inverse of `toVectorLiteral` — pgvector renders `::text` the same bracketed form back. */
function parseVectorLiteral(text: string): number[] {
  return text
    .slice(1, -1)
    .split(',')
    .map((v) => Number(v))
}

/**
 * ANN search against `pageEmbeddingChunks`, scoped to one site/locale, ordered by cosine distance to
 * `vector` — the one primitive both hops share (hop 2 differs only in which vector it passes in,
 * per #3100's own scope: "reuse #3099's query function with a different input vector rather than
 * duplicating the ANN/filter logic").
 *
 * Returns raw, unfiltered rows — `filterVisible` is applied by the caller (`hop1`/`hop2` below),
 * matching `modules/search/shared.ts`'s own convention of filtering result rows rather than folding
 * visibility into the SQL itself (a page rule can turn on a regex or a tag set, neither of which a
 * `WHERE` clause here can express).
 */
export async function annSearch(
  vector: number[],
  siteId: string,
  locale: string
): Promise<SemanticChunkMatch[]> {
  const vectorLiteral = toVectorLiteral(vector)
  const result = await WIKI.db.execute(sql`
    SELECT
      c."pageId" AS "pageId",
      p.path AS path,
      p.locale AS locale,
      p.title AS title,
      p.description AS description,
      p.icon AS icon,
      p.tags AS tags,
      p.classification AS classification,
      c."chunkText" AS "chunkText",
      c."chunkIndex" AS "chunkIndex",
      (c.embedding <=> ${vectorLiteral}::vector) AS distance,
      (c.embedding::text) AS embedding
    FROM "pageEmbeddingChunks" c
    JOIN pages p ON p.id = c."pageId"
    WHERE p."siteId" = ${siteId} AND p.locale = ${locale}
    ORDER BY c.embedding <=> ${vectorLiteral}::vector
    LIMIT ${SEMANTIC_SCAN_CAP}
  `)
  return (result.rows as any[]).map((row) => ({
    pageId: row.pageId as string,
    path: row.path as string,
    locale: row.locale as string,
    title: row.title as string,
    description: (row.description as string | null) ?? null,
    icon: (row.icon as string | null) ?? null,
    tags: (row.tags as string[]) ?? [],
    classification: (row.classification as string | null) ?? null,
    chunkText: row.chunkText as string,
    chunkIndex: row.chunkIndex as number,
    distance: Number(row.distance),
    embedding: parseVectorLiteral(row.embedding as string)
  }))
}

/** Hop 1: ANN search on the query's own embedding, then `filterVisible`. */
export async function hop1(
  queryVector: number[],
  siteId: string,
  locale: string,
  actor: AccessActor | undefined
): Promise<HopOutcome> {
  const scanned = await annSearch(queryVector, siteId, locale)
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

/**
 * The top `count` distinct pages from hop 1's visible results, by each page's own best chunk.
 *
 * Pure — it only re-sorts rows hop 1 already fetched, no DB access of its own. The actual hop-2
 * query (re-running `annSearch` on each seed's own `embedding`) is `hop2` below.
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
 * Hop 2: for each seed's own best chunk, ANN search using THAT CHUNK's embedding as the query vector
 * (not the original query text/vector) — the actual semantic hop. Reuses `annSearch` rather than
 * duplicating the ANN/filter logic, per #3100's own scope.
 */
export async function hop2(
  seeds: SemanticChunkMatch[],
  siteId: string,
  locale: string,
  actor: AccessActor | undefined
): Promise<HopOutcome> {
  const scanned: SemanticChunkMatch[] = []
  for (const seed of seeds) {
    scanned.push(...(await annSearch(seed.embedding, siteId, locale)))
  }
  const visible = filterVisible(scanned, actor, siteId, toVisibilityRef)
  return { scanned, visible }
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
 * Pure — this is the function `semanticSearch.test.ts` targets directly, per this Task's own
 * acceptance criteria ("no `WIKI` global, no database, no model needed").
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
 * Pure — the same "no `WIKI`, no database" unit this Task's acceptance criteria targets.
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
 * `WIKI.models.semanticSearch.search(...)` is what `api/pages/read.ts`'s semantic search route
 * (#3102) wraps. Degrades to an empty, non-approximate result set when local embedding inference is
 * unavailable (`embedText` returns `null`) — the same "hide rather than fail" posture
 * `WIKI.capabilities.semanticSearch` gives the rest of this feature (design doc's scope decision 8).
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

  const hop1Result = await hop1(queryVector, siteId, locale, actor)
  const seeds = selectHop2Seeds(hop1Result.visible)
  const hop2Result = seeds.length > 0 ? await hop2(seeds, siteId, locale, actor) : EMPTY_HOP_OUTCOME

  return mergeHopResults(hop1Result, hop2Result, { offset, limit })
}

export const semanticSearch = {
  search
}
