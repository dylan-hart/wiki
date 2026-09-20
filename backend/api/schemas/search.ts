import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  app.addSchema({
    $id: 'SearchEngine',
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: 'Directory name under `modules/search`.'
      },
      title: {
        type: 'string'
      },
      description: {
        type: 'string'
      },
      icon: {
        type: 'string'
      },
      logo: {
        type: 'string'
      },
      vendor: {
        type: 'string'
      },
      website: {
        type: 'string'
      },
      props: {
        type: 'object',
        additionalProperties: true,
        description:
          "The engine configuration, declared in its `definition.yml`: each entry carries a `type`, `title`, `hint`, `default` and the display hints the admin area renders a control from. A `readOnly` prop is shown but cannot be changed, and is silently kept at its stored value when written to. A `required` prop (e.g. Algolia's `apiKey`, Elasticsearch's `hosts`) must resolve to a non-empty value to select this engine; a `pattern` prop must additionally match that regular expression once non-empty."
      },
      hasImplementation: {
        type: 'boolean',
        description: 'Whether a `search.ts` sits next to the definition.'
      },
      isSelected: {
        type: 'boolean',
        description: "Whether this is the site's currently active engine."
      },
      config: {
        type: 'object',
        additionalProperties: true,
        description:
          'Values for the engine props, completed with the engine defaults for any prop that has none stored yet. Kept even for an engine that is not currently selected, so switching back to it does not lose what was entered.'
      },
      dictOverrides: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description:
          'The `db` engine only: locale code to postgres text search dictionary, e.g. `{ "en": "english" }`. Not a declared prop -- it is a free-form map `parseModuleProps` cannot validate -- so it travels here rather than in `config`, and is absent on every other engine.'
      },
      availableDictionaries: {
        type: 'array',
        items: { type: 'string' },
        description:
          'The `db` engine only: dictionary names this postgres installation actually has, for validating `dictOverrides` before it is saved. Absent on every other engine.'
      }
    }
  })

  app.addSchema({
    $id: 'SemanticSearchResult',
    type: 'object',
    properties: {
      pageId: { type: 'string', format: 'uuid' },
      path: { type: 'string' },
      locale: { type: 'string' },
      title: { type: 'string' },
      description: { type: ['string', 'null'] },
      icon: { type: ['string', 'null'] },
      chunkText: {
        type: 'string',
        description:
          "The stored page-content chunk this result's embedding matched against -- semantic search's own excerpt, since it has no matched query terms to highlight the way a full-text `pages/search` result's `highlight` does."
      },
      chunkIndex: {
        type: 'integer',
        description: "Which chunk of the page's content this is, in the order it was split into."
      },
      distance: {
        type: 'number',
        description:
          'Cosine distance between the query embedding and this chunk -- smaller is closer. A page appearing in both hops keeps its real, unpenalized hop-1 distance.'
      },
      hop: {
        type: 'integer',
        enum: [1, 2],
        description:
          "Which hop of the retrieval pipeline this page's best-matching chunk was found in. `1` for a direct match on the query embedding, including a page that ALSO turned up as a hop-2 seed's neighbour -- appearing in both hops always reports its real, unpenalized hop-1 distance, never `2`. `2` only for a page found solely by following a hop-1 result's own embedding to a further page."
      }
    }
  })

  app.addSchema({
    $id: 'SemanticSearchPagesResult',
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: { $ref: 'SemanticSearchResult#' }
      },
      totalHits: {
        type: 'integer',
        description:
          'How many pages match and are visible to you, ignoring `limit`/`offset` -- counted only from rows that survived `filterVisible`, same meaning as `SearchPagesResult.totalHits`.'
      },
      totalHitsApproximate: {
        type: 'boolean',
        description:
          "`true` when this searcher's page rules dropped one or more of the pipeline's own matches, so `totalHits` is a floor rather than exact -- same meaning as `SearchPagesResult.totalHitsApproximate`."
      },
      suggestion: {
        type: ['string', 'null'],
        description: 'Always `null` -- semantic search has no "did you mean" of its own.'
      }
    }
  })
}
