import { limitRenders } from '../helpers/rateLimit.ts'
import type { FastifyInstance } from 'fastify'
import type { DiagramProxyRequest } from '../models/diagramProxy.ts'

/**
 * Diagram Proxy Routes (OpenProject task 3228, Feature 3183)
 *
 * One shared, site-scoped route: POST a Kroki or PlantUML diagram's source and get the rendered image
 * back — the transport `block-kroki`/`block-plantuml` (OpenProject task 3229) switch to instead of
 * packing the source into a GET URL with an 8,000-character ceiling.
 *
 * A separate file from `api/diagrams.ts` rather than a second route inside it, and NOT registered with
 * that file's `{ prefix: '/diagrams' }` in `api/index.ts`: `diagrams.ts` is mounted under that fixed
 * prefix, which a route declared here with a differently-shaped absolute path (`/sites/:siteId/...`)
 * cannot escape from inside the same plugin instance. There is consequently no path collision with the
 * existing, unrelated `POST /diagrams/render` — that route stays session-authenticated and unscoped
 * (PDF export, MCP); this one is public and site-scoped. See `models/diagramProxy.ts`'s class comment
 * for why the two are also separate models rather than one shared implementation.
 */
async function routes(app: FastifyInstance) {
  /**
   * RENDER A DIAGRAM (KROKI/PLANTUML PROXY)
   */
  app.post<{ Params: { siteId: string }; Body: DiagramProxyRequest }>(
    '/sites/:siteId/diagrams/render',
    {
      /*
        No route-level `permissions`, and no in-handler check either: this is reachable anonymously,
        on purpose, the same way the GET-URL `<img src>` transport it replaces always was. A reader
        who can see the page embedding this block already has the fenced source sitting in the page's
        own markup (`read:pages` on the page itself is what gated that) — this call carries nothing
        the page didn't already expose, only asks the server to draw it instead of the reader's own
        browser doing the GET.
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
      // -> Freshly drawn from whatever source was posted, and cheap to ask for again — nothing here
      //    is worth a client or intermediary holding onto. Same choice `api/diagrams.ts` makes.
      reply.header('Cache-Control', 'no-store')
      reply.header('Content-Length', result.data.length)
      return reply.type(result.contentType).send(result.data)
    }
  )
}

export default routes
