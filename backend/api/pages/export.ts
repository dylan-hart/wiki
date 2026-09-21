import type { FastifyInstance } from 'fastify'
import { limitRenders } from '../../helpers/rateLimit.ts'
import { actorFrom, mayReadSource, requireReadablePage } from '../../helpers/pageAccess.ts'
import { sessionCookieName } from '../../helpers/security.ts'

/** The home page's path is empty, hence the `home` fallback. */
function exportFilenameStem(path: string): string {
  const segment = path.split('/').filter(Boolean).pop() || 'home'
  return segment.replaceAll(/[^a-z0-9-]+/gi, '-')
}

async function routes(app: FastifyInstance) {
  app.get<{ Params: { siteId: string; pageId: string } }>(
    '/sites/:siteId/pages/:pageId/export/pdf',
    {
      /*
        No route-level `permissions`: `read:pages` is a page permission granted by a rule, checked
        against this page below. Exporting shows nothing a reader could not already see.
      */
      // -> A headless browser per request, the same cost as a re-render, so it shares that throttle
      preHandler: limitRenders,
      schema: {
        summary: 'Export a page as PDF',
        description:
          "Drives Puppeteer against this instance's own live page view — not the stored render — so the PDF matches what a reader sees: theme, layout and block components (Mermaid diagrams, PlantUML, …) included, once their own async drawing has settled. Needs the Puppeteer extension, and answers 503 without it.\n\nNeeds `read:pages` ON THIS PAGE, on the same terms as reading it: a password-protected page answers only once the session has satisfied `POST …/unlock`. Requires a logged in user (session or personal access token) on top of that, the same rule the page re-render route above and `POST /diagrams/render` already apply to every other route that launches a headless browser — an anonymous request never reaches Puppeteer, however readable the page itself is (OpenProject #2258/#2262). The export runs as whoever asked for it — nothing more.",
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

      const pdf = await CARDINAL.models.pdfExport.exportPdf({
        hostname: req.hostname,
        port: CARDINAL.config.port,
        path: page.path,
        // -> The raw, still-signed value as the browser sent it: the headless browser replays it
        sessionCookie: req.cookies?.[sessionCookieName()] ?? null
      })

      reply.header(
        'Content-Disposition',
        `attachment; filename="${exportFilenameStem(page.path)}.pdf"`
      )
      reply.header('X-Content-Type-Options', 'nosniff')
      reply.header('Content-Length', pdf.length)
      return reply.type('application/pdf').send(pdf)
    }
  )

  app.get<{
    Params: { siteId: string; pageId: string }
    Querystring: { format: 'markdown' | 'html' }
  }>(
    '/sites/:siteId/pages/:pageId/export',
    {
      /*
        No route-level `permissions`: page permissions are granted by a rule and checked against
        this page below. `format=markdown` returns the raw stored `content`, so it needs source
        access on top of `read:pages`; `format=html` returns the sanitized `render` a reader sees
        anyway.
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
      /*
        `requireReadablePage`'s `permission` option takes one permission string, which cannot
        express `mayReadSource`'s OR, so the source check is a separate step. `allowLocked: true`
        defers the lock check to below so the documented order holds: missing → 404, second
        permission → 403, then still-locked → 403.
      */
      const page = await requireReadablePage(req, reply, req.params.siteId, req.params.pageId, {
        withContent: wantsMarkdown,
        allowLocked: true
      })
      if (!page) {
        return reply
      }
      if (wantsMarkdown && !mayReadSource(req, req.params.siteId, page)) {
        return reply.forbidden("You are not allowed to read this page's source.")
      }
      if (page.isLocked) {
        return reply.forbidden('This page is password protected.')
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
