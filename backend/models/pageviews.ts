import crypto from 'node:crypto'
import { eq, lt, sql } from 'drizzle-orm'
import { pageviews as pageviewsTable } from '../db/schema.ts'

/**
 * `browser` (session/cookie-identified), `api` (a bearer API key on the REST page-read route) and
 * `mcp` (the `get_page` tool -- the same bearer-key mechanism, counted apart).
 */
export const pageviewClientTypes = ['browser', 'api', 'mcp'] as const
export type PageviewClientType = (typeof pageviewClientTypes)[number]

function isPageviewClientType(value: string): value is PageviewClientType {
  return (pageviewClientTypes as readonly string[]).includes(value)
}

/** Matches the 2-year retention (`purgeExpired()`), so `last2yr` and "all-time" are one query. */
const pageviewWindows = ['last30d', 'last6mo', 'last2yr'] as const
export type PageviewWindow = (typeof pageviewWindows)[number]

const WINDOW_INTERVALS: Record<PageviewWindow, string> = {
  last30d: '30 days',
  last6mo: '6 months',
  last2yr: '2 years'
}

/** Distinct visitors, not raw row counts. */
export type PageviewCountsByClientType = {
  browser: number
  api: number
  mcp: number
  all: number
}

/** `total` is the raw (not-distinct) row count for the same breakdown; it sums cleanly the way
 *  `all` does, since a row count carries no visitor identity to double-count. */
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

/** The shape `countsForGraph()` returns for a page it does have an entry for, so a caller never
 *  has to special-case a page with no rows. */
export function zeroPageviewCountsForGraph(): PageviewCountsForGraph {
  return {
    last30d: zeroPageviewWindowCounts(),
    last6mo: zeroPageviewWindowCounts(),
    last2yr: zeroPageviewWindowCounts()
  }
}

export interface PageviewSummary {
  /** Row count within the 2-year retention window -- "all-time" for practical purposes. */
  totalViews: number
  last24h: number
  last7d: number
  distinctPages: number
  /** ISO instant, millisecond precision. */
  mostRecentAt: string | null
}

function emptyPageviewSummary(): PageviewSummary {
  return { totalViews: 0, last24h: 0, last7d: 0, distinctPages: 0, mostRecentAt: null }
}

/**
 * Keyed (HMAC-SHA256), not a bare digest, because the preimages are neither secret nor large:
 * `browser` views hash `sessions.id`, stored verbatim beside `sessions.userId` in the same
 * database, and `api`/`mcp` views hash an API key's UUID, a set small enough to enumerate and
 * pre-hash. Unkeyed, a single join would re-identify every surviving session's pageviews. `key` is
 * `CARDINAL.config.pageviews.hashKey`, generated at first run and never derived from the raw id.
 */
export function hashVisitor(rawId: string, key: string): string {
  return crypto.createHmac('sha256', key).update(rawId).digest('hex')
}

export interface RecordPageviewParams {
  siteId: string
  pageId: string
  clientType: PageviewClientType
  /** Raw session id (`browser`) or API key id (`api`/`mcp`); hashed before it is ever stored. */
  visitorRawId: string
}

/**
 * A log, not a counter: counting DISTINCT visitors over a trailing window is something a running
 * total can never answer once the window has closed over it. Every write path goes through
 * `record()` rather than inserting directly, so the admin opt-out and the best-effort guarantee
 * live in exactly one place.
 */
class Pageviews {
  /**
   * Swap the key, persist it, and restore the previous value if the save fails. Deliberately does
   * not touch a single existing `pageviews` row: breaking correlation with pre-rotation rows is the
   * entire point of a rotation, not a regression to migrate around.
   */
  async rotateHashKey(): Promise<boolean> {
    const previousConfig = CARDINAL.config.pageviews
    CARDINAL.config.pageviews = {
      ...previousConfig,
      hashKey: crypto.randomBytes(32).toString('hex')
    }
    // -> Propagates as `reloadConfig`, so every other instance is holding the new key immediately.
    if (!(await CARDINAL.configSvc.saveToDb(['pageviews']))) {
      CARDINAL.config.pageviews = previousConfig
      return false
    }

    CARDINAL.logger.info('config', 'rotated the pageview hash key')
    return true
  }

  /**
   * Best-effort: never throws, since serving a page must not fail because logging the view did. No
   * row is inserted at all while `CARDINAL.config.pageviews.isEnabled` is off -- the admin opt-out stops
   * the write, it does not merely hide what was written.
   */
  async record(params: RecordPageviewParams): Promise<void> {
    if (CARDINAL.config.pageviews?.isEnabled !== true) {
      return
    }
    try {
      await CARDINAL.db.insert(pageviewsTable).values({
        siteId: params.siteId,
        pageId: params.pageId,
        clientType: params.clientType,
        visitorHash: hashVisitor(params.visitorRawId, CARDINAL.config.pageviews.hashKey)
      })
    } catch (err: any) {
      CARDINAL.logger.warn('pages', 'recording a pageview failed', {
        page: params.pageId,
        error: err
      })
    }
  }

  /**
   * Unlike `countsForGraph()`, deliberately NOT gated on `CARDINAL.config.pageviews.isEnabled`: an admin
   * who has just turned tracking off still needs to see what was recorded before that, and this
   * runs only when one admin page is loaded, not on every page read.
   */
  async summary(): Promise<PageviewSummary> {
    const rows = await CARDINAL.db
      .select({
        totalViews: sql<number>`count(*)::int`,
        last24h: sql<number>`count(case when ${pageviewsTable.viewedAt} >= now() - interval '24 hours' then 1 end)::int`,
        last7d: sql<number>`count(case when ${pageviewsTable.viewedAt} >= now() - interval '7 days' then 1 end)::int`,
        distinctPages: sql<number>`count(distinct ${pageviewsTable.pageId})::int`,
        // -> A raw `sql` aggregate, not a plain column read: the driver hands back a
        //    postgres-format string (`2026-07-25 13:17:36.230177+00`), not a `Date`, so this is
        //    parsed below with `Temporal.Instant.from()` rather than `.toTemporalInstant()`.
        mostRecentAt: sql<string | null>`max(${pageviewsTable.viewedAt})`
      })
      .from(pageviewsTable)

    const row = rows[0]
    if (!row || row.totalViews === 0) {
      return emptyPageviewSummary()
    }
    return {
      totalViews: row.totalViews,
      last24h: row.last24h,
      last7d: row.last7d,
      distinctPages: row.distinctPages,
      mostRecentAt: row.mostRecentAt
        ? Temporal.Instant.from(row.mostRecentAt).toString({ smallestUnit: 'millisecond' })
        : null
    }
  }

  /**
   * Every window and client type in one payload, so the frontend's client-type checkboxes and
   * window selector both work client-side with no re-fetch on either.
   *
   * `all` is a plain sum of the three per-clientType distinct counts rather than a fourth
   * `distinct` query, and is exact rather than approximate: a visitor's identity is scoped to its
   * own `clientType`'s hash domain -- a `browser` view hashes the session id, an `api`/`mcp` view
   * the calling key's id -- so one real visitor can never land in two of the three buckets.
   */
  async countsForGraph(siteId: string): Promise<Map<string, PageviewCountsForGraph>> {
    // -> Reads gate on the same flag writes do: the table can still hold two years of rows from
    //    before tracking was turned off, and there is no reason for every `/graph` request to
    //    aggregate them for a disabled feature.
    if (CARDINAL.config.pageviews?.isEnabled !== true) {
      return new Map()
    }

    const distinct30d = sql<number>`count(distinct case when ${pageviewsTable.viewedAt} >= now() - interval '${sql.raw(WINDOW_INTERVALS.last30d)}' then ${pageviewsTable.visitorHash} end)::int`
    const distinct6mo = sql<number>`count(distinct case when ${pageviewsTable.viewedAt} >= now() - interval '${sql.raw(WINDOW_INTERVALS.last6mo)}' then ${pageviewsTable.visitorHash} end)::int`
    const distinct2yr = sql<number>`count(distinct case when ${pageviewsTable.viewedAt} >= now() - interval '${sql.raw(WINDOW_INTERVALS.last2yr)}' then ${pageviewsTable.visitorHash} end)::int`
    const total30d = sql<number>`count(case when ${pageviewsTable.viewedAt} >= now() - interval '${sql.raw(WINDOW_INTERVALS.last30d)}' then 1 end)::int`
    const total6mo = sql<number>`count(case when ${pageviewsTable.viewedAt} >= now() - interval '${sql.raw(WINDOW_INTERVALS.last6mo)}' then 1 end)::int`
    const total2yr = sql<number>`count(case when ${pageviewsTable.viewedAt} >= now() - interval '${sql.raw(WINDOW_INTERVALS.last2yr)}' then 1 end)::int`

    const rows = await CARDINAL.db
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

  async purgeExpired(): Promise<number> {
    const result = await CARDINAL.db
      .delete(pageviewsTable)
      .where(lt(pageviewsTable.viewedAt, sql`now() - interval '2 years'`))
    return result.rowCount ?? 0
  }
}

export const pageviews = new Pageviews()
