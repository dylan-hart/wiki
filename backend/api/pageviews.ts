import type { FastifyInstance } from 'fastify'
import { zeroPageviewCountsForGraph } from '../models/pageviews.ts'

/** One page's row in the Page Views admin table (OpenProject #2791). */
export interface PageviewTableRow {
  pageId: string
  path: string
  locale: string
  title: string
  /** Sum of `browser` + `mcp` + `api` for this page. */
  total: number
  browser: number
  mcp: number
  api: number
}

/**
 * Per-page pageview counts for `AdminPageviews.vue`'s sortable table (OpenProject #2791) -- distinct
 * from `GET /sites/:siteId/graph`, which serves the same underlying
 * `WIKI.models.pageviews.countsForGraph()` shape but for node-sizing, not a page-by-page admin
 * breakdown. Every browsable page on the site is listed (via `WIKI.models.pages.listAllForGraph()`,
 * unfiltered by publish state -- the caller already holds `manage:system`), zeroed for one with no
 * pageview rows at all, so the table's row count matches the site's page count rather than only the
 * pages that happen to have traffic.
 *
 * Uses the `last2yr` window's `total` (raw, not distinct-visitor) figures -- the same "all-time
 * within retention" convention `Graph.vue`'s node sizing already follows, per
 * `models/pageviews.ts#countsForGraph`'s own doc comment.
 *
 * No sort/filter querystring: sorting happens client-side against this one fetched payload, the
 * same `<w-table>` `sortable` convention `AdminScheduler.vue`/`AdminUsers.vue` already use, since
 * this page has no existing paginated list endpoint to extend.
 */
async function routes(app: FastifyInstance) {
  /**
   * GET PER-PAGE PAGEVIEW COUNTS
   */
  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/pageviews',
    {
      config: {
        permissions: ['manage:system']
      },
      schema: {
        summary: 'Per-page pageview counts for a site',
        description:
          "Every browsable page on the site, with its total pageview count (OpenProject #1238) broken down by client type -- browser, api, mcp -- over the last2yr retention window. Zeroed for a page with no recorded views. Reflects the same figures `countsForGraph()` computes for the knowledge graph's node sizing, reshaped for a flat per-page table rather than graph nodes.",
        tags: ['System'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          200: {
            description: 'Per-page pageview counts',
            type: 'array',
            items: {
              type: 'object',
              properties: {
                pageId: { type: 'string' },
                path: { type: 'string' },
                locale: { type: 'string' },
                title: { type: 'string' },
                total: { type: 'number' },
                browser: { type: 'number' },
                mcp: { type: 'number' },
                api: { type: 'number' }
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req): Promise<PageviewTableRow[]> => {
      const [pages, counts] = await Promise.all([
        WIKI.models.pages.listAllForGraph(req.params.siteId),
        WIKI.models.pageviews.countsForGraph(req.params.siteId)
      ])

      return pages.map((page) => {
        const entry = counts.get(page.id) ?? zeroPageviewCountsForGraph()
        const { browser, mcp, api, all } = entry.last2yr.total
        return {
          pageId: page.id,
          path: page.path,
          locale: page.locale,
          title: page.title,
          total: all,
          browser,
          mcp,
          api
        }
      })
    }
  )
}

export default routes
