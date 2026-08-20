import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * DIAGRAM RENDER REQUEST
   */
  app.addSchema({
    $id: 'DiagramRenderRequest',
    type: 'object',
    required: ['type', 'source'],
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
      },
      server: {
        type: 'string',
        description: 'PlantUML only. The public PlantUML server when left empty.'
      }
    }
  })
}
