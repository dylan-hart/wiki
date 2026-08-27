import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * DIAGRAM RENDER REQUEST
   */
  app.addSchema({
    $id: 'DiagramRenderRequest',
    type: 'object',
    required: ['type', 'source'],
    // -> No per-request `server` override: which PlantUML server this renders against is read from
    //    the site's own `block-plantuml` config (OpenProject task 2223), never from the caller, so
    //    Fastify's default `removeAdditional` strips a `server` field rather than forwarding it.
    additionalProperties: false,
    properties: {
      type: {
        type: 'string',
        enum: ['mermaid', 'plantuml'],
        description: 'The diagram engine the source is written for.'
      },
      source: {
        type: 'string',
        description: "The diagram's fenced source, exactly as an author would write it."
      },
      theme: {
        type: 'string',
        description:
          'Mermaid only. One of default/dark/neutral/forest; anything else, `auto` included, falls back to default — there is no reader here for `auto` to follow.'
      },
      format: {
        type: 'string',
        enum: ['svg', 'png'],
        default: 'svg'
      }
    }
  })
}
