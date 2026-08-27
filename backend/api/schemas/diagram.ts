import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * DIAGRAM RENDER REQUEST
   */
  app.addSchema({
    $id: 'DiagramRenderRequest',
    type: 'object',
    required: ['type', 'source'],
    // -> Closes the door all the way on the removed `server` override (OpenProject #2219): a stray
    //    or forwarded `server` field is stripped by Fastify's default `removeAdditional` AJV option
    //    before the request body ever reaches the model, rather than silently passing through
    //    unused (which `additionalProperties`'s absence would otherwise allow).
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
