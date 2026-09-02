import { siteIdForHostname } from '../helpers/siteResolution.ts'
import { limitRenders } from '../helpers/rateLimit.ts'
import type { FastifyInstance } from 'fastify'
import type { DiagramRenderRequest } from '../models/diagramRender.ts'

/**
 * Diagram Routes
 *
 * One route: render a Mermaid or PlantUML diagram to a static image server-side, for a context that
 * cannot or should not run the block's own client-side JS to draw one — see
 * `models/diagramRender.ts`'s class comment for the design this settles on.
 */
async function routes(app: FastifyInstance) {
  /**
   * RENDER A DIAGRAM
   */
  app.post<{ Body: DiagramRenderRequest }>(
    '/render',
    {
      /*
        No route-level `permissions`: this touches no page and no group-wide capability, only a
        session — the same shape `/profile` uses in `api/users.ts`. Session-authenticated rather than
        anonymous because a Mermaid request launches a full headless browser, the same per-request
        cost `limitRenders` already exists to bound; PlantUML is cheap by comparison but shares the
        route and the limit rather than needing a second one.
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
      // -> Not site-scoped by route (no `:siteId`, and this is reachable from any hostname a
      //    Mermaid/PdfExport caller happens to render from), so the site is resolved the same way
      //    other non-site-scoped surfaces read it off the request itself — see `index.ts`'s SEO hook.
      //    Only PlantUML's render path actually reads it (its site's `block-plantuml` config), but
      //    it's resolved unconditionally so a caller can never pass one of its own.
      //
      // -> Through `siteIdForHostname` rather than indexing `WIKI.sitesMappings` with the raw
      //    hostname, which is what this used to do: those keys are lowercased (OpenProject #2127), so
      //    a mixed-case `Host` header missed the site it addressed and fell through to the `*`
      //    catch-all's PlantUML config. Every other hostname lookup already folded the case.
      const siteId = siteIdForHostname(req.hostname)
      const result = await WIKI.models.diagramRender.render(req.body, siteId)
      // -> Freshly drawn from whatever source was posted, and cheap to ask for again — nothing here
      //    is worth a client or intermediary holding onto
      reply.header('Cache-Control', 'no-store')
      reply.header('Content-Length', result.data.length)
      return reply.type(result.contentType).send(result.data)
    }
  )
}

export default routes
