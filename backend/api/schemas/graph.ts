import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
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
