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

// -> Re-exported so `graph.test.ts` (OpenProject #884) can import the fixture row shape from the
//    same module it imports `assembleGraph`/`folderOf` from, without a second import line pointing
//    at `models/pages.ts`.
export type { GraphPageRow }

/** One node in the knowledge graph (OpenProject #872) — a page the requester may read. */
export interface GraphNode {
  /** Composite `${locale}:${path}` id (OpenProject #1621/#1626) -- translations share a `path` by
   *  design (`docs/decisions/locale-translation-linking.md`, "Same-path-by-convention"), so `path`
   *  alone cannot uniquely identify a node once a site has more than one locale. Edges are keyed on
   *  this, not on `path`. */
  id: string
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
   *  the graph's edit-volume node sizing. Omitted entirely (OpenProject #1863) unless the request
   *  carries `?sizing=` -- these, together with `pageviews` below, dominate the per-node payload
   *  and most readers never look at them. Present and zeroed (not omitted) for a page with no
   *  history to look up, whenever sizing data was asked for at all. */
  contributors?: PageHistoryContributorCounts
  /** Unique-visitor counts from this page's pageview log (OpenProject #1140), the source for the
   *  graph's page-visit-volume node sizing -- split by trailing window and client type so the
   *  frontend's window selector and client-type checkboxes both work client-side against this one
   *  fetched payload. Omitted entirely (OpenProject #1863) unless the request carries `?sizing=`,
   *  same gating as `contributors` above. Present and zeroed (not omitted) for a page with no
   *  pageviews logged (including while `WIKI.config.pageviews.isEnabled` is off, in which case
   *  there is nothing to log in the first place), whenever sizing data was asked for at all. */
  pageviews?: PageviewCountsForGraph
}

/** One edge — an authored relation or an extracted internal link, always between two visible nodes.
 *  `source`/`target` are `GraphNode.id` composite ids (OpenProject #1626), not bare paths. */
export interface GraphEdge {
  source: string
  target: string
  type: 'relation' | 'link'
  label?: string
}

export interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** Whether the node set was cut off by `GRAPH_NODE_CAP` (OpenProject #1866) -- when true, `nodes`
   *  holds only the first `GRAPH_NODE_CAP` of `totalNodes` readable pages, and every edge touching a
   *  dropped node has been dropped with it. */
  truncated: boolean
  /** Count of pages the caller may read, before the cap is applied -- equal to `nodes.length` when
   *  `truncated` is false. */
  totalNodes: number
}

/**
 * Hard ceiling on nodes returned by one `assembleGraph` call (OpenProject #1866). Unbounded, the
 * response is one row (plus contributor/pageview count objects) per readable page -- multi-megabyte
 * JSON and a multi-second force-layout block on a wiki of a few thousand pages, with no degradation
 * path. This is a first hedge, not a redesign of #848's fetch-once-and-filter-client-side shape (a
 * `?folder=`/`?depth=` neighbourhood parameter is the follow-up if that shape ever needs revisiting)
 * -- picked generously enough that it should rarely bite in practice, retune via this one constant
 * once real graph sizes are observed.
 */
export const GRAPH_NODE_CAP = 2000

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
 *
 * `includeSizing` (OpenProject #1863) gates whether `contributors`/`pageviews` are attached to each
 * node at all -- both together, not independently, since `Graph.vue`'s sizing-mode toggle switches
 * client-side with no refetch and needs both dimensions already on hand either way. Defaults to
 * `true` so an existing caller that doesn't care about the gate (every pure-unit test that predates
 * #1863) keeps seeing the same all-present shape it always has; the route below passes the real
 * `Boolean(req.query.sizing)` explicitly.
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
  // -> A relation/link target is a bare path, resolved within the target's own locale (translations
  //    share a path by design -- `docs/decisions/locale-translation-linking.md`), so it must be
  //    paired with the *source* row's locale, not looked up as a path on its own, or an `en` page's
  //    link would count as visible when only a `fr`-locale page occupies that path (OpenProject
  //    #1621/#1626).
  const nodeId = (locale: string, path: string) => `${locale}:${path}`

  const totalNodes = visible.length
  const truncated = totalNodes > GRAPH_NODE_CAP

  // -> Deterministic, not arbitrary DB row order (OpenProject #1866's "not arbitrary row order"
  //    requirement): sort by composite id before capping, so which pages survive a truncated
  //    response is stable across requests and across a physical row order Postgres gives no
  //    guarantee on -- and stays a total order even across locales sharing a path (#1621/#1626).
  const retained = truncated
    ? [...visible]
        .sort((a, b) => nodeId(a.locale, a.path).localeCompare(nodeId(b.locale, b.path)))
        .slice(0, GRAPH_NODE_CAP)
    : visible

  // -> Rebuilt from `retained`, not `visible`: this is what keeps edge assembly below internally
  //    consistent -- an edge whose source or target got capped out is dropped along with it, for
  //    free, by the same `visibleIds.has(...)` checks that already filter out unreadable pages.
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
      // -> A relation's `target` is a bare path with no locale of its own -- it can only ever mean
      //    "the page at this path in the SAME locale as the page carrying the relation" (translations
      //    are separate rows, each with its own relations), so it resolves against `row.locale`.
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

/** OpenProject #1863: opt-in to each node's `contributors`/`pageviews` count objects, which
 *  dominate the per-node payload and which most readers of the default view never look at.
 *  `Graph.vue` sends its currently-active "Size by" mode as the value, but only presence is
 *  checked here -- see `assembleGraph`'s `includeSizing` doc comment for why both objects always
 *  come back together regardless of which mode the value names. */
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
 * The graph bundle for a site -- from the cache when warm, or rebuilt (and cached) on a cold one.
 *
 * A cold rebuild is refused with `null` for a caller with no session (OpenProject #2269), matching
 * the reasoning `docs/variances.md:709` applies to `POST /_api/diagrams/render`: the three underlying
 * queries scale with the whole site's page/history/pageview row counts, so an anonymous caller must
 * not be able to force that cost on demand by simply outracing the TTL or hitting a just-invalidated
 * cache. A signed-in caller needs no specific permission to trigger it -- the same "logged in is
 * enough" shape `/profile` and `/diagrams/render` use -- since the rebuilt bundle is unfiltered raw
 * data (fetched with `publicOnly: false`) and every response is narrowed to the actual caller both by
 * `read:pages` permission (`assembleGraph`'s `canRead`) AND, for a caller with no session, by
 * publication state (OpenProject #1587 §2 / #1612 -- see the route handler below), regardless of who
 * happened to warm the cache.
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
    WIKI.models.pages.listAllForGraph(siteId),
    WIKI.models.pageHistory.contributorCountsForGraph(siteId),
    WIKI.models.pageviews.countsForGraph(siteId)
  ])
  const data: GraphCacheData = { rows, contributorCounts, pageviewCounts }
  setCachedGraphData(siteId, data)
  return data
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
      // -> The cached bundle is fetched once with `publicOnly: false` (`loadGraphData` above) and
      //    shared across every caller, so a session-less caller's publication-state exclusion
      //    (OpenProject #1587 §2 / #1612 -- a draft or scheduled page must never reach an anonymous
      //    reader) has to be re-applied here per request rather than at the SQL layer, on top of --
      //    not instead of -- `assembleGraph`'s own `read:pages` permission narrowing below.
      const rows = authenticated
        ? data.rows
        : data.rows.filter((row) => row.publishState === 'published')
      // -> Built once per request rather than once per row -- `mayOnPage()` rebuilds it internally
      //    on every call, and the graph's input is unbounded (`listAllForGraph()` selects every page
      //    row for the site with no limit). See `tree.ts`'s `visibleTreeItems()` for the same shape.
      const actor = WIKI.models.groups.actorForRequest(req)
      return assembleGraph(
        rows,
        (row) =>
          WIKI.models.groups.checkAccess(actor, 'read:pages', {
            ...row,
            classification: row.classification ?? null,
            siteId: req.params.siteId
          }),
        (id) => WIKI.models.classificationLevels.byId(id)?.name ?? null,
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
