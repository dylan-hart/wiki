import crypto from 'node:crypto'
import { lt, sql } from 'drizzle-orm'
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
