import crypto from 'node:crypto'
import { eq, lt, sql } from 'drizzle-orm'
import { pageviews as pageviewsTable } from '../db/schema.ts'

/**
 * `browser` (session/cookie-identified), `api` (a bearer API key hitting the REST page-read route) or
 * `mcp` (the MCP `get_page` tool -- the same bearer-key mechanism under the hood, counted apart per
 * OpenProject #1140's explicit "web browser vs. API/MCP access" breakdown). A closed list rather than
 * the db column's own varchar shape -- see `db/schema.ts#pageviews`'s doc comment for why that column
 * stays a plain varchar instead of a real pg enum.
 */
export const pageviewClientTypes = ['browser', 'api', 'mcp'] as const
export type PageviewClientType = (typeof pageviewClientTypes)[number]

function isPageviewClientType(value: string): value is PageviewClientType {
  return (pageviewClientTypes as readonly string[]).includes(value)
}

/**
 * The three fixed trailing windows OpenProject #1140's graph node sizing aggregates over --
 * matching the 2-year retention (`purgeExpired()` below), so "last2yr" and "all-time" are the same
 * query once that has run.
 */
export const pageviewWindows = ['last30d', 'last6mo', 'last2yr'] as const
export type PageviewWindow = (typeof pageviewWindows)[number]

const WINDOW_INTERVALS: Record<PageviewWindow, string> = {
  last30d: '30 days',
  last6mo: '6 months',
  last2yr: '2 years'
}

/** Unique-visitor counts for one page within one trailing window, split by `clientType`. */
export type PageviewCountsByClientType = {
  browser: number
  api: number
  mcp: number
  /** The union across all three -- see `countsForGraph()`'s doc comment for why this is a plain sum,
   *  not a separate dedup query the way `pageHistory.contributorCountsForGraph()`'s `all` is. */
  all: number
}

/** One trailing window's unique-visitor counts, plus the sibling raw (not-distinct) row counts for
 *  the same breakdown -- OpenProject #1269's Unique/Total graph-sizing toggle. `total` sums cleanly
 *  the same way `all` above does: a raw row count carries no visitor identity to double-count. */
export type PageviewWindowCounts = PageviewCountsByClientType & {
  total: PageviewCountsByClientType
}

export type PageviewCountsForGraph = Record<PageviewWindow, PageviewWindowCounts>

function zeroPageviewCountsByClientType(): PageviewCountsByClientType {
  return { browser: 0, api: 0, mcp: 0, all: 0 }
}

function zeroPageviewWindowCounts(): PageviewWindowCounts {
  return { ...zeroPageviewCountsByClientType(), total: zeroPageviewCountsByClientType() }
}

/** All-zero counts for a page with no pageview rows at all -- the same shape `countsForGraph()`
 *  returns for a page it has an entry for, so a caller never has to special-case "missing". */
export function zeroPageviewCountsForGraph(): PageviewCountsForGraph {
  return {
    last30d: zeroPageviewWindowCounts(),
    last6mo: zeroPageviewWindowCounts(),
    last2yr: zeroPageviewWindowCounts()
  }
}

/**
 * Never store a raw session id or API key id -- `visitorHash` only needs to tell two visitors apart,
 * not identify either one. Two different keys/sessions hash to two different visitors; the same one
 * reused is one visitor, which is exactly what a unique-visitor count needs and nothing more.
 */
export function hashVisitor(rawId: string): string {
  return crypto.createHash('sha256').update(rawId).digest('hex')
}

export interface RecordPageviewParams {
  siteId: string
  pageId: string
  clientType: PageviewClientType
  /** The raw session id (`browser`) or API key id (`api`/`mcp`) -- hashed before it is ever stored. */
  visitorRawId: string
}

/**
 * Pageviews model
 *
 * A log, not a counter: OpenProject #1140 (the knowledge graph sizing nodes by visit volume) needs to
 * count DISTINCT visitors over any of three trailing windows -- 30 days / 6 months / 2 years -- which a
 * running total could never answer once the window closed over it. Two write paths exist,
 * `api/pages.ts`'s page-read route and `mcp/tools/getPage.ts`'s `get_page` tool, both calling `record()`
 * here rather than inserting directly, so the admin opt-out and the best-effort guarantee live in
 * exactly one place.
 */
class Pageviews {
  /**
   * Log one page view, best-effort. Never throws -- serving the page itself must never fail because
   * logging that it happened did, so neither call site needs its own try/catch around this.
   *
   * No-ops entirely (no row is ever inserted) while `WIKI.config.pageviews.isEnabled` is off, which is
   * the whole of the admin opt-out's mechanism -- turning tracking off stops the write, it does not
   * merely hide what already got written.
   */
  async record(params: RecordPageviewParams): Promise<void> {
    if (WIKI.config.pageviews?.isEnabled !== true) {
      return
    }
    try {
      await WIKI.db.insert(pageviewsTable).values({
        siteId: params.siteId,
        pageId: params.pageId,
        clientType: params.clientType,
        visitorHash: hashVisitor(params.visitorRawId)
      })
    } catch (err: any) {
      WIKI.logger.warn(`Failed to record a pageview: ${err.message}`)
    }
  }

  /**
   * Unique-visitor counts per page, for OpenProject #1140's "size by page visit volume" node sizing --
   * the `pageviewsFor` accessor `api/graph.ts#assembleGraph` takes, same testability shape as
   * `pageHistory.contributorCountsForGraph()` (#1141). Split by `clientType` across each of the three
   * fixed trailing windows (30 days / 6 months / 2 years, matching retention) so the frontend's
   * client-type checkboxes and window selector both work client-side against one fetched payload,
   * with no re-fetch on either control changing -- the same "fetched once" design the rest of the
   * graph follows (see `api/graph.ts`'s own doc comment on `assembleGraph`).
   *
   * Unlike `contributorCountsForGraph()`, no separate "overall" query is needed for the `all` bucket:
   * a contributor's identity there (`authorId`) is the SAME value regardless of which channel
   * (`via`) they used, so summing `editor` + `mcp` would double-count a contributor who used both.
   * A visitor's identity here is scoped to its own `clientType`'s hash domain instead -- a `browser`
   * view hashes the session id, an `api`/`mcp` view hashes the calling key's id -- so a `browser`
   * hash and an `api` hash can never coincide for the same real visitor. Summing the three
   * per-clientType distinct counts is therefore already exact, not an approximation: `all` is that
   * sum, computed directly below rather than with a fourth query.
   *
   * Each window also carries a sibling `total` -- the raw (not `distinct`) row count for the same
   * window/clientType breakdown, OpenProject #1269's counterpart to the unique counts above, for the
   * frontend's Unique/Total sizing toggle (#1270). Computed in the same query and the same
   * `GROUP BY`, since a raw `count(*)` needs no identity column at all.
   */
  async countsForGraph(siteId: string): Promise<Map<string, PageviewCountsForGraph>> {
    const distinct30d = sql<number>`count(distinct case when ${pageviewsTable.viewedAt} >= now() - interval '${sql.raw(WINDOW_INTERVALS.last30d)}' then ${pageviewsTable.visitorHash} end)::int`
    const distinct6mo = sql<number>`count(distinct case when ${pageviewsTable.viewedAt} >= now() - interval '${sql.raw(WINDOW_INTERVALS.last6mo)}' then ${pageviewsTable.visitorHash} end)::int`
    const distinct2yr = sql<number>`count(distinct case when ${pageviewsTable.viewedAt} >= now() - interval '${sql.raw(WINDOW_INTERVALS.last2yr)}' then ${pageviewsTable.visitorHash} end)::int`
    const total30d = sql<number>`count(case when ${pageviewsTable.viewedAt} >= now() - interval '${sql.raw(WINDOW_INTERVALS.last30d)}' then 1 end)::int`
    const total6mo = sql<number>`count(case when ${pageviewsTable.viewedAt} >= now() - interval '${sql.raw(WINDOW_INTERVALS.last6mo)}' then 1 end)::int`
    const total2yr = sql<number>`count(case when ${pageviewsTable.viewedAt} >= now() - interval '${sql.raw(WINDOW_INTERVALS.last2yr)}' then 1 end)::int`

    const rows = await WIKI.db
      .select({
        pageId: pageviewsTable.pageId,
        clientType: pageviewsTable.clientType,
        last30d: distinct30d,
        last6mo: distinct6mo,
        last2yr: distinct2yr,
        last30dTotal: total30d,
        last6moTotal: total6mo,
        last2yrTotal: total2yr
      })
      .from(pageviewsTable)
      .where(eq(pageviewsTable.siteId, siteId))
      .groupBy(pageviewsTable.pageId, pageviewsTable.clientType)

    const totalKeys = {
      last30d: 'last30dTotal',
      last6mo: 'last6moTotal',
      last2yr: 'last2yrTotal'
    } as const

    const result = new Map<string, PageviewCountsForGraph>()
    for (const row of rows) {
      if (!isPageviewClientType(row.clientType)) {
        continue
      }
      const clientType = row.clientType
      const entry = result.get(row.pageId) ?? zeroPageviewCountsForGraph()
      for (const window of pageviewWindows) {
        const count = row[window]
        entry[window][clientType] = count
        entry[window].all += count
        const totalCount = row[totalKeys[window]]
        entry[window].total[clientType] = totalCount
        entry[window].total.all += totalCount
      }
      result.set(row.pageId, entry)
    }
    return result
  }

  /**
   * Sweeps rows older than the 2-year retention window (`tasks/simple/purge-pageviews.ts`), the same
   * span as #1140's longest trailing window -- "all-time" and "2 years" are the same query once this
   * has run. Mirrors `rateLimits.purgeStale()`'s shape: one statement, no batching.
   */
  async purgeExpired(): Promise<number> {
    const result = await WIKI.db
      .delete(pageviewsTable)
      .where(lt(pageviewsTable.viewedAt, sql`now() - interval '2 years'`))
    return result.rowCount ?? 0
  }
}

export const pageviews = new Pageviews()
