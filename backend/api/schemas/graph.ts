import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
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
      }
    },
    required: ['editor', 'mcp', 'all']
  })

  /**
   * GRAPHNODE — one page the caller may read, as a knowledge-graph node (OpenProject #872).
   */
  app.addSchema({
    $id: 'GraphNode',
    type: 'object',
    properties: {
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
          "Unique-contributor counts from this page's edit history (OpenProject #1141), the source for the graph's edit-volume node sizing."
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
      source: { type: 'string', description: 'Source node path.' },
      target: { type: 'string', description: 'Target node path.' },
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
