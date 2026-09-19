import type { FastifyInstance } from 'fastify'
import { zeroPageviewCountsForGraph } from '../models/pageviews.ts'

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
 * Lists every browsable page, unfiltered by publish state (the caller holds `manage:system`) and
 * zeroed when it has no views, so the table's row count matches the site's page count. Figures are
 * the `last2yr` window's raw totals, not distinct visitors: 2 years is the retention, so that is
 * all-time. No sort or filter querystring: the admin table sorts client-side.
 */
async function routes(app: FastifyInstance) {
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
        CARDINAL.models.pages.listAllForGraph(req.params.siteId),
        CARDINAL.models.pageviews.countsForGraph(req.params.siteId)
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
