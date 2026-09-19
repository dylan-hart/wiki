import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  app.addSchema({
    $id: 'DiagramRenderRequest',
    type: 'object',
    required: ['type', 'source'],
    // -> No `server` field: which PlantUML server this renders against comes from the site's own
    //    `block-plantuml` config, never from the caller. Fastify's default `removeAdditional`
    //    strips one rather than forwarding it.
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

  /**
   * For the site-scoped, anonymous-reachable proxy route (`api/diagramProxy.ts`): it names an
   * ENGINE (kroki/plantuml), where `DiagramRenderRequest` names a diagram TYPE for the
   * session-authenticated `/diagrams/render`. No `server` field here either, for the same reason.
   */
  app.addSchema({
    $id: 'DiagramProxyRenderRequest',
    type: 'object',
    required: ['engine', 'source'],
    additionalProperties: false,
    properties: {
      engine: {
        type: 'string',
        enum: ['kroki', 'plantuml'],
        description: 'The diagram engine to render against.'
      },
      source: {
        type: 'string',
        description: "The diagram's fenced source, exactly as an author would write it."
      },
      diagramType: {
        type: 'string',
        description:
          "Kroki only, required for it. Which of Kroki's diagram languages `source` is written in — Kroki cannot tell from the text alone."
      },
      format: {
        type: 'string',
        enum: ['svg', 'png'],
        default: 'svg'
      }
    }
  })
}
