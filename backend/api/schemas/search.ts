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
}
