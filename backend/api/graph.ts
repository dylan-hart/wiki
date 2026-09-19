import type { FastifyInstance } from 'fastify'
import type { GraphPageRow } from '../models/pages.ts'
import type { PageHistoryContributorCounts } from '../models/pageHistory.ts'
import type { PageviewCountsForGraph } from '../models/pageviews.ts'
import { zeroPageviewCountsForGraph } from '../models/pageviews.ts'
import {
  getCachedGraphData,
  setCachedGraphData,
  type GraphCacheData
} from '../helpers/graphCache.ts'

// -> Re-exported for `graph.test.ts`'s fixtures.
export type { GraphPageRow }

export interface GraphNode {
  /** Composite `${locale}:${path}`: translations share a `path` by design, so `path` alone cannot
   *  identify a node. Edges are keyed on this. */
  id: string
  path: string
  locale: string
  title: string
  icon: string | null
  tags: string[]
  /** The path's first segment. */
  folder: string
  /** The classification level's display name; null when the id no longer resolves to a level. */
  classification: string | null
  /** Omitted unless the request carries `?sizing=` -- this and `pageviews` dominate the per-node
   *  payload. When asked for, a page with no history gets zeroes, not an omission. */
  contributors?: PageHistoryContributorCounts
  /** Same gating and zeroing as `contributors`. Split by trailing window and client type so the
   *  frontend's selectors work client-side against one fetched payload. */
  pageviews?: PageviewCountsForGraph
}

/** Always between two visible nodes; `source`/`target` are `GraphNode.id` composite ids. */
export interface GraphEdge {
  source: string
  target: string
  type: 'relation' | 'link'
  label?: string
}

export interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** True when `nodes` was cut off at `GRAPH_NODE_CAP`; every edge touching a dropped node is
   *  dropped with it. */
  truncated: boolean
  /** Pages the caller may read, before the cap is applied. */
  totalNodes: number
}

/**
 * Uncapped, the response is one node per readable page: multi-megabyte JSON and a multi-second
 * force-layout block on a wiki of a few thousand pages. Generous on purpose; retune here.
 */
export const GRAPH_NODE_CAP = 2000

export function folderOf(path: string): string {
  return path.split('/')[0] ?? ''
}

/**
 * Takes predicates and resolvers rather than a request, so it is testable with no `CARDINAL` global
 * and no database. `includeSizing` attaches `contributors` and `pageviews` together, never one
 * alone: `Graph.vue` switches sizing mode client-side with no refetch.
 */
export function assembleGraph(
  rows: GraphPageRow[],
  canRead: (row: GraphPageRow) => boolean,
  classificationName: (id: string) => string | null = (id) => id,
  contributorsFor: (pageId: string) => PageHistoryContributorCounts = () => ({
    editor: 0,
    mcp: 0,
    all: 0,
    total: { editor: 0, mcp: 0, all: 0 }
  }),
  pageviewsFor: (pageId: string) => PageviewCountsForGraph = zeroPageviewCountsForGraph,
  includeSizing = true
): Graph {
  const visible = rows.filter(canRead)
  // -> A relation or link target is a bare path meaning "the page at this path in its source's own
  //    locale" (translations are separate rows), so a target pairs with the SOURCE row's locale --
  //    else an `en` link would resolve to a page only the `fr` locale has at that path.
  const nodeId = (locale: string, path: string) => `${locale}:${path}`

  const totalNodes = visible.length
  const truncated = totalNodes > GRAPH_NODE_CAP

  // -> Sorted by composite id before capping, so which pages survive truncation is stable across
  //    requests: Postgres guarantees no row order.
  const retained = truncated
    ? [...visible]
        .sort((a, b) => nodeId(a.locale, a.path).localeCompare(nodeId(b.locale, b.path)))
        .slice(0, GRAPH_NODE_CAP)
    : visible

  // -> From `retained`, not `visible`: an edge to a capped-out node is then dropped by the same
  //    `visibleIds.has(...)` checks that drop an edge to an unreadable page.
  const visibleIds = new Set(retained.map((row) => nodeId(row.locale, row.path)))

  const nodes: GraphNode[] = retained.map((row) => ({
    id: nodeId(row.locale, row.path),
    path: row.path,
    locale: row.locale,
    title: row.title,
    icon: row.icon,
    tags: row.tags,
    folder: folderOf(row.path),
    classification: classificationName(row.classification),
    ...(includeSizing
      ? { contributors: contributorsFor(row.id), pageviews: pageviewsFor(row.id) }
      : {})
  }))

  const edges: GraphEdge[] = []
  for (const row of retained) {
    const sourceId = nodeId(row.locale, row.path)
    for (const relation of row.relations) {
      const targetId = nodeId(row.locale, relation.target)
      if (visibleIds.has(targetId)) {
        edges.push({
          source: sourceId,
          target: targetId,
          type: 'relation',
          label: relation.label
        })
      }
    }
    for (const target of row.links) {
      const targetId = nodeId(row.locale, target)
      if (visibleIds.has(targetId)) {
        edges.push({ source: sourceId, target: targetId, type: 'link' })
      }
    }
  }

  return { nodes, edges, truncated, totalNodes }
}

const graphQuerystring = {
  type: 'object',
  properties: {
    sizing: {
      type: 'string',
      enum: ['edits', 'visits'],
      description:
        "When present, every node also carries its `contributors` and `pageviews` count objects (omitted by default to keep the default view's payload lean). The value should match the caller's active sizing mode, but presence alone -- not the specific value -- decides whether sizing data comes back."
    }
  }
}

/**
 * A cold rebuild is refused (`null`) when `mayRebuild` is false: the three queries scale with the
 * whole site's page, history and pageview rows, so an anonymous caller must not be able to force
 * that cost by outracing the TTL. Any signed-in caller may trigger one -- the bundle is unfiltered,
 * and every response is narrowed to its own caller regardless of who warmed the cache.
 */
async function loadGraphData(siteId: string, mayRebuild: boolean): Promise<GraphCacheData | null> {
  const cached = getCachedGraphData(siteId)
  if (cached) {
    return cached
  }
  if (!mayRebuild) {
    return null
  }
  const [rows, contributorCounts, pageviewCounts] = await Promise.all([
    CARDINAL.models.pages.listAllForGraph(siteId),
    CARDINAL.models.pageHistory.contributorCountsForGraph(siteId),
    CARDINAL.models.pageviews.countsForGraph(siteId)
  ])
  const data: GraphCacheData = { rows, contributorCounts, pageviewCounts }
  setCachedGraphData(siteId, data)
  return data
}

/**
 * No route-level `permissions`: `read:pages` is a page-rule permission, checked per page by the
 * `canRead` predicate handed to `assembleGraph`.
 */
async function routes(app: FastifyInstance) {
  app.get<{ Params: { siteId: string }; Querystring: { sizing?: string } }>(
    '/sites/:siteId/graph',
    {
      schema: {
        summary: "The site's knowledge graph",
        description:
          "Every page the caller may read on this site, across all locales, as nodes -- plus the relation and internal-link edges between pages that are both visible. Fetched once; every drill-down filter and re-cluster after that (OpenProject #874/#875) runs client-side against this response, per #848's design. The underlying data is cached per site for a short TTL (OpenProject #2269); a cold cache is only rebuilt for a signed-in caller.",
        tags: ['Pages'],
        params: { $ref: 'SiteIdParams#' },
        querystring: graphQuerystring,
        response: {
          200: { $ref: 'Graph#' },
          401: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const authenticated = req.session?.authenticated === true
      const data = await loadGraphData(req.params.siteId, authenticated)
      if (!data) {
        return reply.unauthorized(
          'Sign in to load the knowledge graph the first time; it stays cached for everyone after that.'
        )
      }
      // -> The cached bundle is unfiltered and shared by every caller, so keeping a draft or
      //    scheduled page from an anonymous reader happens here per request, not in SQL -- on top
      //    of, not instead of, the `read:pages` narrowing below.
      const rows = authenticated
        ? data.rows
        : data.rows.filter((row) => row.publishState === 'published')
      // -> Built once per request: `mayOnPage()` would rebuild it for every row, and the row count
      //    is unbounded.
      const actor = CARDINAL.models.groups.actorForRequest(req)
      return assembleGraph(
        rows,
        (row) =>
          CARDINAL.models.groups.checkAccess(actor, 'read:pages', {
            ...row,
            classification: row.classification ?? null,
            siteId: req.params.siteId
          }),
        (id) => CARDINAL.models.classificationLevels.byId(id)?.name ?? null,
        (pageId) =>
          data.contributorCounts.get(pageId) ?? {
            editor: 0,
            mcp: 0,
            all: 0,
            total: { editor: 0, mcp: 0, all: 0 }
          },
        (pageId) => data.pageviewCounts.get(pageId) ?? zeroPageviewCountsForGraph(),
        Boolean(req.query.sizing)
      )
    }
  )
}

export default routes
