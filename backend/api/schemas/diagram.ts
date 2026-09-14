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

  /**
   * DIAGRAM PROXY RENDER REQUEST
   *
   * `POST /_api/sites/:siteId/diagrams/render` (`api/diagramProxy.ts`) — the shared Kroki/PlantUML
   * POST proxy, distinct from `DiagramRenderRequest` above: that one names a diagram TYPE
   * (mermaid/plantuml) for the session-authenticated, unscoped `/diagrams/render` route; this one
   * names an ENGINE (kroki/plantuml) for a site-scoped, anonymous-reachable route, and Kroki also
   * needs `diagramType` — which of Kroki's own diagram languages `source` is written in, since Kroki
   * is a front end to many tools rather than one of its own.
   */
  app.addSchema({
    $id: 'DiagramProxyRenderRequest',
    type: 'object',
    required: ['engine', 'source'],
    // -> No `server` field, same reasoning as `DiagramRenderRequest` above: which server this
    //    renders against is read from the site's own block config (`models/diagramProxy.ts`), never
    //    from the caller.
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
