import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * GRAPHTOTALCONTRIBUTORCOUNTS — raw (not distinct) history-row counts for one page's edit history,
   * split by `via`, the sibling of GRAPHCONTRIBUTORCOUNTS below for the Unique/Total sizing toggle
   * (OpenProject #1269/#1270). Registered before GRAPHCONTRIBUTORCOUNTS, which `$ref`s it.
   */
  app.addSchema({
    $id: 'GraphTotalContributorCounts',
    type: 'object',
    properties: {
      editor: {
        type: 'integer',
        description: 'History rows recorded through the standard web editor / REST save.'
      },
      mcp: {
        type: 'integer',
        description: 'History rows recorded through an MCP tool call.'
      },
      all: {
        type: 'integer',
        description: 'History rows across both channels combined -- a plain sum of the two above.'
      }
    },
    required: ['editor', 'mcp', 'all']
  })

  /**
   * GRAPHCONTRIBUTORCOUNTS — unique-contributor counts for one page's edit history, split by
   * `pageHistory.via` (OpenProject #1141). Registered before GRAPHNODE, which `$ref`s it.
   */
  app.addSchema({
    $id: 'GraphContributorCounts',
    type: 'object',
    properties: {
      editor: {
        type: 'integer',
        description: 'Unique contributors who edited through the standard web editor / REST save.'
      },
      mcp: {
        type: 'integer',
        description: 'Unique contributors who edited through an MCP tool call.'
      },
      all: {
        type: 'integer',
        description:
          'Unique contributors across both channels combined -- not the sum of the two above, since a contributor who used both would otherwise be counted twice.'
      },
      total: {
        $ref: 'GraphTotalContributorCounts#',
        description:
          "Raw history-row counts (not distinct authors) for the same via split, OpenProject #1269 -- unlike `all` above, not filtered to surviving authors, so a since-deleted contributor's edits still count here."
      }
    },
    required: ['editor', 'mcp', 'all', 'total']
  })

  /**
   * GRAPHTOTALPAGEVIEWWINDOWCOUNTS — raw (not distinct) pageview-row counts for one page within one
   * trailing window, split by `clientType`, the sibling of GRAPHPAGEVIEWWINDOWCOUNTS below for the
   * Unique/Total sizing toggle (OpenProject #1269/#1270). Registered before it, which `$ref`s it.
   */
  app.addSchema({
    $id: 'GraphTotalPageviewWindowCounts',
    type: 'object',
    properties: {
      browser: { type: 'integer', description: 'Pageview rows logged through a web browser.' },
      api: { type: 'integer', description: 'Pageview rows logged through the REST API.' },
      mcp: { type: 'integer', description: 'Pageview rows logged through an MCP tool call.' },
      all: {
        type: 'integer',
        description: 'Pageview rows across all three client types combined for this window.'
      }
    },
    required: ['browser', 'api', 'mcp', 'all']
  })

  /**
   * GRAPHPAGEVIEWWINDOWCOUNTS — unique-visitor counts for one page within one trailing window,
   * split by pageview `clientType` (OpenProject #1140). Registered before GRAPHPAGEVIEWCOUNTS,
   * which `$ref`s it once per window.
   */
  app.addSchema({
    $id: 'GraphPageviewWindowCounts',
    type: 'object',
    properties: {
      browser: {
        type: 'integer',
        description: 'Unique visitors (by session/cookie) who read the page through a web browser.'
      },
      api: {
        type: 'integer',
        description: 'Unique visitors (by API key id) who read the page through the REST API.'
      },
      mcp: {
        type: 'integer',
        description: 'Unique visitors (by API key id) who read the page through an MCP tool call.'
      },
      all: {
        type: 'integer',
        description:
          'Unique visitors across all three client types combined for this window -- exactly the sum of the three above, since each client type hashes a disjoint identity space (session id vs. API key id).'
      },
      total: {
        $ref: 'GraphTotalPageviewWindowCounts#',
        description:
          'Raw pageview-row counts (not distinct visitors) for the same window/clientType breakdown, OpenProject #1269.'
      }
    },
    required: ['browser', 'api', 'mcp', 'all', 'total']
  })

  /**
   * GRAPHPAGEVIEWCOUNTS — unique-visitor counts for one page, across the three fixed trailing
   * windows OpenProject #1140's node sizing aggregates over (30 days / 6 months / 2 years, matching
   * the pageview log's own 2-year retention). Registered before GRAPHNODE, which `$ref`s it.
   */
  app.addSchema({
    $id: 'GraphPageviewCounts',
    type: 'object',
    properties: {
      last30d: { $ref: 'GraphPageviewWindowCounts#', description: 'Trailing 30 days.' },
      last6mo: { $ref: 'GraphPageviewWindowCounts#', description: 'Trailing 6 months.' },
      last2yr: {
        $ref: 'GraphPageviewWindowCounts#',
        description: 'Trailing 2 years -- the same span as the pageview log retention window.'
      }
    },
    required: ['last30d', 'last6mo', 'last2yr']
  })

  /**
   * GRAPHNODE — one page the caller may read, as a knowledge-graph node (OpenProject #872).
   */
  app.addSchema({
    $id: 'GraphNode',
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          'Composite `${locale}:${path}` id (OpenProject #1621/#1626) -- unique across locales, since translations share a path by design. Edges are keyed on this, not on `path`.'
      },
      path: { type: 'string' },
      locale: { type: 'string' },
      title: { type: 'string' },
      icon: { type: ['string', 'null'] },
      tags: { type: 'array', items: { type: 'string' } },
      folder: {
        type: 'string',
        description:
          "The path's first segment, e.g. `docs` for `docs/child` — the grouping dimension 874's folder view clusters by."
      },
      classification: {
        type: ['string', 'null'],
        description:
          "The page's classification level display name (OpenProject #1079/#1217), resolved server-side from its classification id. Null when the id no longer resolves to a configured level."
      },
      contributors: {
        $ref: 'GraphContributorCounts#',
        description:
          "Unique-contributor counts from this page's edit history (OpenProject #1141), the source for the graph's edit-volume node sizing. Omitted entirely unless the request carries `?sizing=` (OpenProject #1863)."
      },
      pageviews: {
        $ref: 'GraphPageviewCounts#',
        description:
          "Unique-visitor counts from this page's pageview log (OpenProject #1140), the source for the graph's page-visit-volume node sizing. Zeroed while pageview tracking is disabled (`WIKI.config.pageviews.isEnabled`), same as for a page with no pageviews logged. Omitted entirely unless the request carries `?sizing=` (OpenProject #1863)."
      }
    }
  })

  /**
   * GRAPHEDGE — an authored relation or an extracted internal link between two visible nodes.
   */
  app.addSchema({
    $id: 'GraphEdge',
    type: 'object',
    properties: {
      source: { type: 'string', description: "Source node's composite `${locale}:${path}` id." },
      target: { type: 'string', description: "Target node's composite `${locale}:${path}` id." },
      type: {
        type: 'string',
        enum: ['relation', 'link'],
        description:
          '`relation` comes from pages.relations (authored); `link` from extracted internal links.'
      },
      label: {
        type: 'string',
        description: 'Carried through from the relation. Absent for a `link` edge.'
      }
    }
  })

  /**
   * GRAPH — the whole permitted graph for one site, across all locales, in one response.
   */
  app.addSchema({
    $id: 'Graph',
    type: 'object',
    properties: {
      nodes: { type: 'array', items: { $ref: 'GraphNode#' } },
      edges: { type: 'array', items: { $ref: 'GraphEdge#' } }
    }
  })
}
