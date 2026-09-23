import { sql } from 'drizzle-orm'
import { embedText } from '../helpers/embeddings.ts'
import { buildSqlFilterConditions, filterVisible } from '../modules/search/shared.ts'
import type { AccessActor } from './groups.ts'
import type { VisibilityRef } from '../modules/search/shared.ts'
import type { SearchFilters, SearchPagesResult } from './search.ts'

/**
 * `pageEmbeddingChunks` is deliberately **not** declared in `db/schema.ts` / managed by
 * `drizzle-kit generate` — pgvector is an optional extension (not every host permits installing
 * it) and its absence must never fail a migration or block boot. `core/pgvectorBootstrap.ts`
 * creates the extension and the table imperatively after the normal migrations run, recording
 * success as `CARDINAL.capabilities.semanticSearch`. That is why this model reads the table through
 * a raw `sql` template rather than the schema-DSL query builder — a deliberate exception to the
 * "all schema changes go through `db/schema.ts`" rule.
 */

/**
 * Overfetch ceiling for one ANN search, applied identically to hop 1 and to every hop-2 seed's own
 * query: page-rule filtering cannot be expressed in the `WHERE`/`ORDER BY` a vector index answers,
 * so it runs per-row in this process afterward, and a fixed cap is what stops a reader denied
 * nearly everything from turning one call into an unbounded index scan.
 */
export const SEMANTIC_SCAN_CAP = 50

export const HOP2_SEED_COUNT = 3

/**
 * Added to a hop-2-ONLY page's distance before ranking, so a direct (hop-1) match always outranks
 * an equally-distant hop-2-only one — it really is one step further removed.
 */
export const HOP2_DISTANCE_PENALTY = 0.1

export function maxDistanceForMinMatch(minMatchPercent: number): number | null {
  if (!Number.isFinite(minMatchPercent) || minMatchPercent <= 0) {
    return null
  }
  return 1 - Math.min(minMatchPercent, 100) / 100
}

export interface SemanticChunkMatch {
  pageId: string
  chunkIndex: number
  chunkText: string
  /** Carried so hop 2 can re-query with a seed chunk's own vector. */
  embedding: number[]
  /** Cosine distance to the query vector — smaller is closer. */
  distance: number
  path: string
  locale: string
  title: string
  description: string | null
  icon: string | null
  tags: string[]
  classification: string | null
}

/** The gap between `scanned` and `visible` is what `totalHitsApproximate` is computed from. */
export interface HopOutcome {
  scanned: SemanticChunkMatch[]
  visible: SemanticChunkMatch[]
}

export type SemanticSearchPagesResult = Omit<SearchPagesResult, 'results'> & {
  results: SemanticSearchResult[]
}

export interface SemanticSearchResult {
  pageId: string
  path: string
  locale: string
  title: string
  description: string | null
  icon: string | null
  chunkText: string
  chunkIndex: number
  /** Unpenalized, even for a hop-2 row; a page in both hops keeps its hop-1 value. */
  distance: number
  /** `2` only when the page was hop-2-ONLY; a page appearing in both hops reports `1`. */
  hop: 1 | 2
}

export interface AnnSearchScope extends SearchFilters {
  siteId: string
  /** Never empty — the route defaults it to the site's primary locale. */
  locales: string[]
  actor?: AccessActor
  maxDistance?: number | null
}

/** `actor` is excluded deliberately: permission filtering is `filterVisible`'s job, never SQL. */
type ChunkFilters = Omit<AnnSearchScope, 'siteId' | 'actor' | 'maxDistance'>

function toVisibilityRef(row: SemanticChunkMatch): VisibilityRef {
  return {
    path: row.path,
    locale: row.locale,
    tags: row.tags,
    classification: row.classification
  }
}

/**
 * Validated rather than trusted: the result is bound as a parameter, never interpolated, so this is
 * not an injection concern — but a `NaN`/`Infinity` from a broken embedding call would otherwise
 * surface as an opaque postgres cast error far from its real cause.
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

/** Tolerates an already-decoded array, since a driver-level type parser could supply one. */
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
 * No permission filtering here — that is every caller's own job, so a caller needing the pre-filter
 * scan count (for `totalHitsApproximate`) can still get it. Both hops go through this one function,
 * which is what stops a page a filter excludes from reappearing by way of hop-2 expansion. Filter
 * semantics mirror `modules/search/db/search.ts`'s, and every value is bound as a parameter.
 */
async function queryChunks(
  embedding: number[],
  siteId: string,
  filters: ChunkFilters,
  maxDistance: number | null = null
): Promise<SemanticChunkMatch[]> {
  const vectorLiteral = toVectorLiteral(embedding)

  const conditions = [sql`p."siteId" = ${siteId}`, ...buildSqlFilterConditions(filters)]
  if (maxDistance !== null) {
    conditions.push(sql`(pec.embedding <=> ${vectorLiteral}::vector) <= ${maxDistance}`)
  }

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
    WHERE ${sql.join(conditions, sql` AND `)}
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
 * Every row goes through `filterVisible` unchanged — the same page-permission guarantee full-text
 * search gives, so semantic search is never a way around page rules.
 *
 * Takes a pre-computed **vector**, never a query string: `runHop2` calls it again with a seed
 * chunk's own embedding rather than new text, which a string-only signature would force it to
 * duplicate this query for. Embedding the query text is `helpers/embeddings.ts#embedText`'s job,
 * one layer up at `search()`.
 */
export async function annSearch(
  embedding: number[],
  { siteId, actor, maxDistance = null, ...filters }: AnnSearchScope
): Promise<SemanticChunkMatch[]> {
  const rows = await queryChunks(embedding, siteId, filters, maxDistance)
  return filterVisible(rows, actor, siteId, toVisibilityRef)
}

export function selectHop2Seeds(
  hop1Visible: SemanticChunkMatch[],
  count = HOP2_SEED_COUNT
): SemanticChunkMatch[] {
  return [...bestChunkPerPage(hop1Visible).values()]
    .sort((a, b) => a.distance - b.distance)
    .slice(0, count)
}

/**
 * The actual semantic hop: each seed is re-queried by its own best chunk's embedding rather than
 * the original query vector, moving from "what matches the literal query" to "what matches the
 * meaning of the best thing the literal query already found".
 *
 * Seeds are pooled, not deduped or penalized — a page reachable via several seeds, or via both
 * hops, appears more than once here on purpose; `dedupeAndRank`/`mergeHopResults` resolves that.
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
 * Duplicates `annSearch` so `search()` can see how many rows were scanned before filtering (for
 * `totalHitsApproximate`) without widening `annSearch`'s own visible-only return shape.
 */
async function hop1Outcome(
  queryVector: number[],
  { siteId, actor, maxDistance = null, ...filters }: AnnSearchScope
): Promise<HopOutcome> {
  const scanned = await queryChunks(queryVector, siteId, filters, maxDistance)
  const visible = filterVisible(scanned, actor, siteId, toVisibilityRef)
  return { scanned, visible }
}

/** `runHop2`'s counterpart, for the same reason `hop1Outcome` is `annSearch`'s. */
async function hop2Outcome(
  seeds: SemanticChunkMatch[],
  { siteId, actor, maxDistance = null, ...filters }: AnnSearchScope
): Promise<HopOutcome> {
  const scannedBatches = await Promise.all(
    seeds.map((seed) => queryChunks(seed.embedding, siteId, filters, maxDistance))
  )
  const scanned = scannedBatches.flat()
  const visible = filterVisible(scanned, actor, siteId, toVisibilityRef)
  return { scanned, visible }
}

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
 * A page with any hop-1 chunk is a hop-1 result outright; its hop-2 rows are ignored rather than
 * competing. `rankDistance` carries the penalty so the reported `distance` never does.
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
 * Counts follow `modules/search/shared.ts#toSearchPagesResult`: `totalHits` is the deduped,
 * page-level visible set, and a scanned-vs-visible mismatch at either hop means permission
 * filtering dropped a counted row, so the total can only be approximate.
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
 * Degrades to an empty, non-approximate result set when local embedding inference is unavailable
 * (`embedText` answers `null`) — the same "hide rather than fail" posture
 * `CARDINAL.capabilities.semanticSearch` takes for the rest of this feature.
 */
export async function search(
  query: string,
  actor: AccessActor | undefined,
  siteId: string,
  locales: string[],
  { limit, offset, ...filters }: Omit<SearchFilters, 'locales'> & { limit: number; offset: number }
): Promise<SemanticSearchPagesResult> {
  const queryVector = await embedText(query)
  if (!queryVector) {
    return { results: [], totalHits: 0, totalHitsApproximate: false, suggestion: null }
  }

  const maxDistance = maxDistanceForMinMatch(
    CARDINAL.models.search.getConfig(siteId).semanticMinMatch
  )
  const scope: AnnSearchScope = { ...filters, siteId, locales, actor, maxDistance }
  const hop1Result = await hop1Outcome(queryVector, scope)
  const seeds = selectHop2Seeds(hop1Result.visible)
  const hop2Result = seeds.length > 0 ? await hop2Outcome(seeds, scope) : EMPTY_HOP_OUTCOME

  return mergeHopResults(hop1Result, hop2Result, { offset, limit })
}

export const semanticSearch = {
  annSearch,
  selectHop2Seeds,
  runHop2,
  bestChunkPerPage,
  dedupeAndRank,
  mergeHopResults,
  search
}
