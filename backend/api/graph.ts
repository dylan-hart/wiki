import type { FastifyInstance } from 'fastify'
import type { GraphPageRow } from '../models/pages.ts'
import type { PageHistoryContributorCounts } from '../models/pageHistory.ts'
import type { PageviewCountsForGraph } from '../models/pageviews.ts'
import { zeroPageviewCountsForGraph } from '../models/pageviews.ts'
import { mayOnPage } from './pages.ts'
import { guardSiteEnabled } from '../helpers/common.ts'

// -> Re-exported so `graph.test.ts` (OpenProject #884) can import the fixture row shape from the
//    same module it imports `assembleGraph`/`folderOf` from, without a second import line pointing
//    at `models/pages.ts`.
export type { GraphPageRow }

/** One node in the knowledge graph (OpenProject #872) — a page the requester may read. */
export interface GraphNode {
  path: string
  locale: string
  title: string
  icon: string | null
  tags: string[]
  /** The path's first segment — the grouping dimension 874's folder view clusters by. */
  folder: string
  /** The page's classification level display name (OpenProject #1079/#1217), resolved from
   *  `GraphPageRow.classification` via `WIKI.models.classificationLevels.byId()`. Null when the
   *  id no longer resolves to a configured level. */
  classification: string | null
  /** Unique-contributor counts from this page's edit history (OpenProject #1141), the source for
   *  the graph's edit-volume node sizing. Always present, zeroed rather than omitted for a page
   *  with no history to look up. */
  contributors: PageHistoryContributorCounts
  /** Unique-visitor counts from this page's pageview log (OpenProject #1140), the source for the
   *  graph's page-visit-volume node sizing -- split by trailing window and client type so the
   *  frontend's window selector and client-type checkboxes both work client-side against this one
   *  fetched payload. Always present, zeroed rather than omitted for a page with no pageviews
   *  logged (including while `WIKI.config.pageviews.isEnabled` is off, in which case there is
   *  nothing to log in the first place). */
  pageviews: PageviewCountsForGraph
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
 *
 * `classificationName` resolves a classification id to its display name (OpenProject #1217) —
 * a separate parameter for the same testability reason as `canRead`: `WIKI.models
 * .classificationLevels.byId()` needs no database either, but a pure-unit test still shouldn't
 * have to stand up the `WIKI` global just to exercise node/edge assembly. Defaults to the
 * identity function so every existing caller that doesn't care about the resolved name keeps
 * working unchanged.
 *
 * `contributorsFor` resolves a page id to its edit-volume contributor counts (OpenProject #1141),
 * same testability reasoning as `classificationName` — defaults to an all-zero stand-in so an
 * existing caller that doesn't care about node sizing keeps working unchanged.
 *
 * `pageviewsFor` resolves a page id to its page-visit-volume counts (OpenProject #1140), same
 * testability reasoning and same all-zero-default shape as `contributorsFor`.
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
  pageviewsFor: (pageId: string) => PageviewCountsForGraph = zeroPageviewCountsForGraph
): Graph {
  const visible = rows.filter(canRead)
  const visiblePaths = new Set(visible.map((row) => row.path))

  const nodes: GraphNode[] = visible.map((row) => ({
    path: row.path,
    locale: row.locale,
    title: row.title,
    icon: row.icon,
    tags: row.tags,
    folder: folderOf(row.path),
    classification: classificationName(row.classification),
    contributors: contributorsFor(row.id),
    pageviews: pageviewsFor(row.id)
  }))

  const edges: GraphEdge[] = []
  for (const row of visible) {
    for (const relation of row.relations) {
      if (visiblePaths.has(relation.target)) {
        edges.push({
          source: row.path,
          target: relation.target,
          type: 'relation',
          label: relation.label
        })
      }
    }
    for (const target of row.links) {
      if (visiblePaths.has(target)) {
        edges.push({ source: row.path, target, type: 'link' })
      }
    }
  }

  return { nodes, edges }
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
 * The response IS cached (OpenProject #2269, see `models/graph.ts`), so a request answered from a
 * warm cache still needs no session -- only rebuilding a cold entry does, checked explicitly below.
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
      const siteId = req.params.siteId

      // -> Cached per site (OpenProject #2269): the three queries behind a cold rebuild are a
      //    site-wide, unbounded page scan and two full-table aggregates, so a request that finds a
      //    warm entry runs none of them. What's cached is the raw material below, never the
      //    assembled/filtered `Graph` -- see `models/graph.ts`'s class comment for why permission
      //    filtering has to run fresh on every request regardless of cache state.
      let data = WIKI.models.graph.get(siteId)
      if (!data) {
        // -> A cold rebuild is refused to an anonymous caller, matching the reasoning
        //    `docs/variances.md` gives for `/diagrams/render`'s own session requirement: the work
        //    behind a miss is expensive enough (an unbounded page scan plus two full-table
        //    aggregates) that leaving it reachable with no session would make this endpoint a
        //    standing invitation to force repeated cold rebuilds for free.
        if (!req.session?.authenticated) {
          return reply.unauthorized(
            'Rebuilding the knowledge graph cache requires a logged in user.'
          )
        }
        const pageviewsEnabled = WIKI.config.pageviews?.isEnabled === true
        const [rows, contributorCounts, pageviewCounts] = await Promise.all([
          WIKI.models.pages.listAllForGraph(siteId),
          WIKI.models.pageHistory.contributorCountsForGraph(siteId),
          // -> Skipped entirely while pageviews are disabled -- there is nothing logged to
          //    aggregate, and running the query anyway would just confirm an empty table.
          pageviewsEnabled
            ? WIKI.models.pageviews.countsForGraph(siteId)
            : Promise.resolve(new Map<string, PageviewCountsForGraph>())
        ])
        data = { rows, contributorCounts, pageviewCounts }
        WIKI.models.graph.set(siteId, data)
      }

      return assembleGraph(
        data.rows,
        (row) => mayOnPage(req, 'read:pages', siteId, row),
        (id) => WIKI.models.classificationLevels.byId(id)?.name ?? null,
        (pageId) =>
          data!.contributorCounts.get(pageId) ?? {
            editor: 0,
            mcp: 0,
            all: 0,
            total: { editor: 0, mcp: 0, all: 0 }
          },
        (pageId) => data!.pageviewCounts.get(pageId) ?? zeroPageviewCountsForGraph()
      )
    }
  )
}

export default routes
