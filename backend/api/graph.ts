import type { FastifyInstance } from 'fastify'
import type { GraphPageRow } from '../models/pages.ts'
import { mayOnPage } from './pages.ts'
import { guardSiteEnabled } from '../helpers/common.ts'

/** One node in the knowledge graph (OpenProject #872) — a page the requester may read. */
export interface GraphNode {
  path: string
  locale: string
  title: string
  icon: string | null
  tags: string[]
  /** The path's first segment — the grouping dimension 874's folder view clusters by. */
  folder: string
}

/** One edge — an authored relation or an extracted internal link, always between two visible nodes. */
export interface GraphEdge {
  source: string
  target: string
  type: 'relation' | 'link'
  label?: string
}

export interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/** A page's first path segment — `docs/child` -> `docs`, the home page (path `''`) -> `''`. */
export function folderOf(path: string): string {
  return path.split('/')[0] ?? ''
}

/**
 * Build the graph from a site's raw page rows, keeping only what `canRead` allows.
 *
 * A plain function taking a predicate rather than a request, so OpenProject #884 can exercise the
 * node/edge assembly + permission-filter logic against a fixture page list with no `WIKI` global
 * and no database (CLAUDE.md's "Testing (backend)" pure-unit convention). This stub is enough to
 * wire the route end to end first — Task 5 (#884) fills in the real body.
 */
export function assembleGraph(
  _rows: GraphPageRow[],
  _canRead: (row: GraphPageRow) => boolean
): Graph {
  return { nodes: [], edges: [] }
}

const siteIdParam = {
  type: 'object',
  properties: { siteId: { type: 'string', format: 'uuid' } },
  required: ['siteId']
}

/**
 * Knowledge Graph API Routes (OpenProject #848 / #872)
 *
 * No route-level `permissions`: `read:pages` is a page-rule permission, checked per page inside
 * `assembleGraph`'s `canRead` predicate below, not the group-wide list `config.permissions` reads.
 */
async function routes(app: FastifyInstance) {
  /**
   * GET GRAPH
   */
  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/graph',
    {
      schema: {
        summary: "The site's knowledge graph",
        description:
          "Every page the caller may read on this site, across all locales, as nodes -- plus the relation and internal-link edges between pages that are both visible. Fetched once; every drill-down filter and re-cluster after that (OpenProject #874/#875) runs client-side against this response, per #848's design.",
        tags: ['Pages'],
        params: siteIdParam,
        response: {
          200: { $ref: 'Graph#' }
        }
      }
    },
    async (req, reply) => {
      if (guardSiteEnabled(WIKI.sites[req.params.siteId], reply)) {
        return
      }
      const rows = await WIKI.models.pages.listAllForGraph(req.params.siteId)
      return assembleGraph(rows, (row) => mayOnPage(req, 'read:pages', req.params.siteId, row))
    }
  )
}

export default routes
