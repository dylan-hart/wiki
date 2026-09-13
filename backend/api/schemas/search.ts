import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * SEARCH ENGINE - A search engine module as offered to a site's engine picker
   */
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

  /**
   * SEMANTIC SEARCH RESULT - One page returned by `GET .../pages/search/semantic` (Epic #3050, Task
   * #3102). Same shape as a plain `pages/search` result -- the two are meant to render through the
   * same result row on the frontend -- plus `hop`, which the multi-hop retrieval pipeline
   * (`models/semanticSearch.ts`, Feature #3092) attaches to say how it found this page.
   */
  app.addSchema({
    $id: 'SemanticSearchResult',
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      path: { type: 'string' },
      locale: { type: 'string' },
      title: { type: 'string' },
      description: { type: ['string', 'null'] },
      icon: { type: ['string', 'null'] },
      tags: { type: 'array', items: { type: 'string' } },
      updatedAt: { type: 'string', format: 'date-time' },
      relevancy: { type: 'number' },
      highlight: {
        type: ['string', 'null'],
        description:
          'Always `null` here -- semantic search has no matched query terms to wrap in `<b>`, unlike a full-text `pages/search` result.'
      },
      hop: {
        type: 'integer',
        enum: [1, 2],
        description:
          "Which hop of the retrieval pipeline this page's best-matching chunk was found in. `1` for a direct match on the query embedding, including a page that ALSO turned up as a hop-2 seed's neighbour -- appearing in both hops always reports its real, unpenalized hop-1 distance, never `2`. `2` only for a page found solely by following a hop-1 result's own embedding to a further page."
      }
    }
  })

  /**
   * SEMANTIC SEARCH PAGES RESULT - The response envelope for `GET .../pages/search/semantic`, mirroring
   * `SearchPagesResult`'s own field-by-field meaning (`api/pages/read.ts`'s `pages/search` route)
   * against the multi-hop pipeline's merged, deduped, permission-filtered result set.
   */
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
