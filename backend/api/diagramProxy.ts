import { limitRenders } from '../helpers/rateLimit.ts'
import type { FastifyInstance } from 'fastify'
import type { DiagramProxyRequest } from '../models/diagramProxy.ts'

/**
 * A separate plugin from `api/diagrams.ts`: that one is mounted under `{ prefix: '/diagrams' }`,
 * which a `/sites/:siteId/...` path cannot escape. Its `POST /diagrams/render` is
 * session-authenticated and unscoped; this route is public and site-scoped.
 */
async function routes(app: FastifyInstance) {
  app.post<{ Params: { siteId: string }; Body: DiagramProxyRequest }>(
    '/sites/:siteId/diagrams/render',
    {
      /*
        No route-level `permissions` and no in-handler check: anonymous on purpose. A reader who can
        see the embedding page already has the diagram source in its markup, so this call exposes
        nothing the page did not.
      */
      preHandler: limitRenders,
      schema: {
        summary: 'Render a Kroki or PlantUML diagram to a static image',
        description:
          "Streams the given diagram source to this site's configured Kroki or PlantUML server and returns the rendered image bytes directly — the POST transport `block-kroki`/`block-plantuml` use, which has no URL-size ceiling to hit.",
        tags: ['Diagrams'],
        params: { $ref: 'SiteIdParams#' },
        body: { $ref: 'DiagramProxyRenderRequest#' },
        response: {
          200: {
            description: 'The rendered diagram',
            content: {
              'image/svg+xml': { schema: { type: 'string', format: 'binary' } },
              'image/png': { schema: { type: 'string', format: 'binary' } }
            }
          },
          400: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          413: { $ref: 'ApiError#' },
          422: { $ref: 'ApiError#' },
          429: { $ref: 'ApiError#' },
          502: { $ref: 'ApiError#' },
          503: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const result = await CARDINAL.models.diagramProxy.render(req.params.siteId, req.body)
      // -> Drawn fresh from the posted source and cheap to redo: nothing worth a cache holding onto.
      reply.header('Cache-Control', 'no-store')
      reply.header('Content-Length', result.data.length)
      return reply.type(result.contentType).send(result.data)
    }
  )
}

export default routes
