import type { FastifyInstance } from 'fastify'
import { requireReadablePage } from '../../helpers/pageAccess.ts'

/**
 * A page's recovery draft (OpenProject #2455): the content a collaboration room was holding when it
 * closed with edits still unsaved. `pages/read.ts`'s `viewer.draft` is the lightweight "there is one"
 * signal folded into an ordinary page read; the two routes here are what the editor calls once the
 * reader has actually decided what to do about it -- fetch the content to restore, or drop it.
 */
async function routes(app: FastifyInstance) {
  /**
   * GET PAGE DRAFT
   */
  app.get<{ Params: { siteId: string; pageId: string } }>(
    '/sites/:siteId/pages/:pageId/draft',
    /*
      No route-level `permissions`: that hook reads the group-wide list, and `write:pages` here is a
      page permission granted by a rule. Checked against this page below instead -- the same
      permission the collaboration websocket itself requires to join a room in the first place
      (`controllers/collab.ts`), since a draft is nothing but a room's own leftover content.
    */
    {
      schema: {
        summary: "Get a page's unsaved recovery draft",
        description:
          "The content a page's collaboration room was holding when it last closed with edits still unsaved -- what the editor offers to restore on reopening after a crash or a closed tab. 404 when there is none, which is the ordinary case: most edits get saved before the room ever closes.\n\nNeeds `write:pages` on this page, the same permission joining the room itself needs -- a draft is nothing but a room's leftover content, and whoever could not have written to the room could not have left anything in it either. Locked (password-protected) pages are not a barrier here, matching the collaboration websocket's own access check.",
        tags: ['Pages'],
        params: { $ref: 'SitePageParams#' },
        response: {
          200: {
            description: 'The stored draft',
            type: 'object',
            properties: {
              content: { type: 'string' },
              title: { type: 'string' },
              description: { type: 'string' },
              icon: { type: 'string' },
              authorName: {
                type: ['string', 'null'],
                description:
                  "Best-effort: who was last known to be editing when the draft was recorded. Null when nobody's name could be attributed."
              },
              updatedAt: { type: 'string', format: 'date-time' }
            }
          },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const page = await requireReadablePage(req, reply, req.params.siteId, req.params.pageId, {
        permission: 'write:pages',
        forbiddenMessage: 'You are not allowed to edit this page.',
        allowLocked: true
      })
      if (!page) {
        return reply
      }
      const draft = await WIKI.models.pageDrafts.getContent(page.id)
      if (!draft) {
        return reply.notFound('There is no unsaved draft for this page.')
      }
      return {
        content: draft.content,
        title: draft.title,
        description: draft.description,
        icon: draft.icon,
        authorName: draft.authorName,
        updatedAt: draft.updatedAt
      }
    }
  )

  /**
   * DISCARD PAGE DRAFT
   */
  app.delete<{ Params: { siteId: string; pageId: string } }>(
    '/sites/:siteId/pages/:pageId/draft',
    // -> No route-level `permissions`: see the GET route above.
    {
      schema: {
        summary: "Discard a page's unsaved recovery draft",
        description:
          'Drops the recovery draft recorded for this page, if there is one. What the editor calls when the reader chooses not to restore it, so the same draft is not offered again the next time this page is opened. Idempotent: a page with no draft answers success the same as one that had one just removed.\n\nNeeds `write:pages` on this page, matching the GET route above.',
        tags: ['Pages'],
        params: { $ref: 'SitePageParams#' },
        response: {
          204: { description: 'Discarded (or there was none to begin with).', type: 'null' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const page = await requireReadablePage(req, reply, req.params.siteId, req.params.pageId, {
        permission: 'write:pages',
        forbiddenMessage: 'You are not allowed to edit this page.',
        allowLocked: true
      })
      if (!page) {
        return reply
      }
      await WIKI.models.pageDrafts.clear(page.id)
      return reply.code(204).send()
    }
  )
}

export default routes
