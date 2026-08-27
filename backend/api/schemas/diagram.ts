import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * DIAGRAM RENDER REQUEST
   */
  app.addSchema({
    $id: 'DiagramRenderRequest',
    type: 'object',
    required: ['type', 'source'],
    // -> Explicit, rather than left to omission: a `server` field (the per-request PlantUML
    //    destination override removed by OpenProject #2219, for the SSRF risk described there) must
    //    never reach `req.body` again. Fastify's ajv compiler defaults to `removeAdditional: true`,
    //    which only strips a property this schema calls out as additional — i.e. only once
    //    `additionalProperties: false` is set here — so leaving this implicit would silently let
    //    `server` (and anything else undeclared) straight through unstripped.
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
