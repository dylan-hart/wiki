import type { FastifyInstance } from 'fastify'
import { limitRenders } from '../../helpers/rateLimit.ts'
import { actorFrom, requireReadablePage } from '../../helpers/pageAccess.ts'
import { sessionCookieName } from '../../helpers/security.ts'

/**
 * A safe filename stem for a page export, from its path.
 *
 * A path is directories joined by `/`; a downloaded file only wants the page's own name, the way
 * `docs/getting-started` becomes `getting-started.pdf` rather than a name with slashes in it. The home
 * page's path is empty, so that falls back to `home`. Shared by every `.../export*` route — PDF,
 * Markdown and HTML alike all name their download off the same rule.
 */
function exportFilenameStem(path: string): string {
  const segment = path.split('/').filter(Boolean).pop() || 'home'
  return segment.replaceAll(/[^a-z0-9-]+/gi, '-')
}

/**
 * Downloading a page as a file: PDF, Markdown or HTML.
 */
async function routes(app: FastifyInstance) {
  /**
   * EXPORT PAGE AS PDF
   */
  app.get<{ Params: { siteId: string; pageId: string } }>(
    '/sites/:siteId/pages/:pageId/export/pdf',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and page permissions are
        granted by a group's RULES. Checked against the page in question below instead, the same
        `read:pages` the page view itself needs — exporting shows nothing a reader could not already
        see.
      */
      // -> Same cost as re-rendering a page — a headless browser per request — so it shares that
      //    route's throttle; see `helpers/rateLimit.ts`
      preHandler: limitRenders,
      schema: {
        summary: 'Export a page as PDF',
        description:
          "Drives Puppeteer against this instance's own live page view — not the stored render — so the PDF matches what a reader sees: theme, layout and block components (Mermaid diagrams, PlantUML, …) included, once their own async drawing has settled. Needs the Puppeteer extension, and answers 503 without it.\n\nNeeds `read:pages` ON THIS PAGE, on the same terms as reading it: a password-protected page answers only once the session has satisfied `POST …/unlock`. Requires a logged in user (session or personal access token) on top of that, the same rule the page re-render route above and `POST /diagrams/render` already apply to every other route that launches a headless browser — an anonymous request never reaches Puppeteer, however readable the page itself is (OpenProject #2258/#2262; see `docs/variances.md`). The export runs as whoever asked for it — nothing more.",
        tags: ['Pages'],
        params: { $ref: 'SitePageParams#' },
        response: {
          200: {
            description: 'The page as a PDF file',
            content: {
              'application/pdf': {
                schema: { type: 'string', format: 'binary' }
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('Exporting a page as PDF requires a logged in user.')
      }
      const page = await requireReadablePage(req, reply, req.params.siteId, req.params.pageId)
      if (!page) {
        return reply
      }

      const pdf = await WIKI.models.pdfExport.exportPdf({
        hostname: req.hostname,
        port: WIKI.config.port,
        path: page.path,
        // -> The raw, still-signed cookie value exactly as the browser sent it — see the AUTH comment
        //    on `PdfExport.exportPdf` for why forwarding it is safe and sufficient
        sessionCookie: req.cookies?.[sessionCookieName()] ?? null
      })

      reply.header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(page.path || 'home')}.pdf"`
      )
      reply.header('X-Content-Type-Options', 'nosniff')
      reply.header('Content-Length', pdf.length)
      return reply.type('application/pdf').send(pdf)
    }
  )

  /**
   * EXPORT PAGE AS MARKDOWN OR HTML
   */
  app.get<{
    Params: { siteId: string; pageId: string }
    Querystring: { format: 'markdown' | 'html' }
  }>(
    '/sites/:siteId/pages/:pageId/export',
    {
      /*
        No route-level `permissions`: `read:pages` is a page permission granted by a group's RULES,
        checked against this page below (through `requireReadablePage`). `format=markdown` sends back the
        raw stored `content` — the same thing `withContent=true` on the GET route above returns — so it
        needs `read:source` ON TOP of `read:pages`, checked the same way. `format=html` sends back the
        already-rendered, already-sanitized `render` a reader sees anyway, so it needs only `read:pages`,
        exactly matching the PDF export above.
      */
      schema: {
        summary: 'Export a page as Markdown or HTML',
        description:
          'The page as a file download rather than JSON, so a plain link to this URL is all a client needs — no client-side Blob assembly.\n\n`format=markdown` is the raw stored source and needs `read:source` on top of `read:pages`. `format=html` is the stored `render` HTML and needs only `read:pages`, on the same terms as the PDF export. Either way a password-protected page answers 403 until the session has satisfied `POST …/unlock`.',
        tags: ['Pages'],
        params: { $ref: 'SitePageParams#' },
        querystring: {
          type: 'object',
          properties: {
            format: {
              type: 'string',
              enum: ['markdown', 'html'],
              description: 'Which representation of the page to download.'
            }
          },
          required: ['format']
        },
        response: {
          200: {
            description: 'The page content in the requested format',
            content: {
              'text/markdown': { schema: { type: 'string' } },
              'text/html': { schema: { type: 'string' } }
            }
          }
        }
      }
    },
    async (req, reply) => {
      const wantsMarkdown = req.query.format === 'markdown'
      const page = await requireReadablePage(req, reply, req.params.siteId, req.params.pageId, {
        withContent: wantsMarkdown,
        // -> A separate permission from `read:pages`, exactly as it is on the GET route above --
        //    and only for `format=markdown`, which is the format that hands back the raw source
        permission: wantsMarkdown ? 'read:source' : undefined,
        forbiddenMessage: "You are not allowed to read this page's source."
      })
      if (!page) {
        return reply
      }
      const stem = exportFilenameStem(page.path)
      if (wantsMarkdown) {
        reply.header('Content-Disposition', `attachment; filename="${stem}.md"`)
        return reply.type('text/markdown; charset=utf-8').send(page.content ?? '')
      }
      reply.header('Content-Disposition', `attachment; filename="${stem}.html"`)
      return reply.type('text/html; charset=utf-8').send(page.render ?? '')
    }
  )
}

export default routes
