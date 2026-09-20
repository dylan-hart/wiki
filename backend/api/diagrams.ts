import { siteIdForHostname } from '../helpers/siteResolution.ts'
import { limitRenders } from '../helpers/rateLimit.ts'
import type { FastifyInstance } from 'fastify'
import type { DiagramRenderRequest } from '../models/diagramRender.ts'

async function routes(app: FastifyInstance) {
  app.post<{ Body: DiagramRenderRequest }>(
    '/render',
    {
      /*
        No route-level `permissions`: this touches no page and no group-wide capability, only a
        session. Session-authenticated rather than anonymous because a Mermaid request launches a
        headless browser; PlantUML is cheap by comparison but shares the route and its limit.
      */
      preHandler: limitRenders,
      schema: {
        summary: 'Render a Mermaid or PlantUML diagram to a static image',
        description:
          "Draws the given diagram source server-side and returns the image bytes directly, for a context that cannot or should not run the block's own client-side JS to draw one — a faster PDF export, or serving a diagram to a client that never loads the block runtime. Mermaid needs the Puppeteer extension and answers 503 without it; PlantUML does not, since `block-plantuml` never draws locally either.",
        tags: ['Diagrams'],
        body: { $ref: 'DiagramRenderRequest#' },
        response: {
          200: {
            description: 'The rendered diagram',
            content: {
              'image/svg+xml': { schema: { type: 'string', format: 'binary' } },
              'image/png': { schema: { type: 'string', format: 'binary' } }
            }
          }
        }
      }
    },
    async (req, reply) => {
      if (!req.session?.authenticated) {
        return reply.unauthorized('Sign in to render a diagram.')
      }
      // -> No `:siteId` on this route, so the site comes from the request hostname. Only PlantUML's
      //    render path reads it, but it is resolved unconditionally so a caller can never pass its
      //    own.
      const siteId = siteIdForHostname(req.hostname)
      const result = await CARDINAL.models.diagramRender.render(req.body, siteId)
      // -> Drawn fresh from the posted source and cheap to redo: nothing worth a cache holding onto.
      reply.header('Cache-Control', 'no-store')
      reply.header('Content-Length', result.data.length)
      return reply.type(result.contentType).send(result.data)
    }
  )
}

export default routes
