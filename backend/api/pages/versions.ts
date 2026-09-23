import type { FastifyInstance } from 'fastify'
import { requireReadablePage } from '../../helpers/pageAccess.ts'

async function routes(app: FastifyInstance) {
  app.get<{ Params: { siteId: string; versionId: string } }>(
    '/sites/:siteId/versions/:versionId',
    {
      // -> No route-level `permissions`: `read:history` is a page permission, checked against the
      //    page the version belongs to in the handler
      schema: {
        summary: 'Get a shareable page version',
        description:
          "One version of a page found by its id alone, for a link that names no page — the counterpart of `GET …/pages/:pageId/history/:versionId`, which needs the page id up front. Carries the source, title and author's name, but neither the version's metadata nor the author's email.\n\nAccess is judged on the page's CURRENT path, tags and classification, not those the version was written under: `read:history` on the page, on the same terms as the history list. A page the caller could not open answers 404, and so does one that has since been deleted, even though its history rows outlive it. A password-protected page answers 403 until the session has satisfied `POST …/unlock`.",
        tags: ['Pages'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' },
            versionId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId', 'versionId']
        },
        response: {
          200: { $ref: 'PageVersionShare#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const version = await CARDINAL.models.pageHistory.getVersionById(
        req.params.siteId,
        req.params.versionId
      )
      if (!version) {
        return reply.notFound('This version does not exist.')
      }
      // -> Judged on the page as it stands NOW, not the path the version was written at; a deleted
      //    page 404s here although its history rows outlive it (`pageHistory.pageId` is not a
      //    foreign key)
      const page = await requireReadablePage(req, reply, req.params.siteId, version.pageId, {
        permission: 'read:history',
        forbiddenMessage: "You are not allowed to read this page's history."
      })
      if (!page) {
        return reply
      }
      const { pageId, ...shared } = version
      return {
        ...shared,
        page: { id: pageId, path: page.path, locale: page.locale }
      }
    }
  )
}

export default routes
