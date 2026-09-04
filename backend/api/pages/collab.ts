import type { FastifyInstance } from 'fastify'
import { requireReadablePage } from '../../helpers/pageAccess.ts'

/**
 * Coordination for a page's live collaboration room -- distinct from the room's own websocket
 * (`controllers/collab.ts`), which is what actually carries the shared document. The one route here
 * answers a question the room's Yjs document cannot safely answer on its own: OpenProject #2516.
 */
async function routes(app: FastifyInstance) {
  /**
   * CLAIM THE WYSIWYG COLLAB SEED
   */
  app.post<{ Params: { siteId: string; pageId: string } }>(
    '/sites/:siteId/pages/:pageId/collab/wysiwyg-seed-claim',
    /*
      No route-level `permissions`: that hook reads the group-wide list, and `write:pages` here is a
      page permission granted by a rule. Checked against this page below instead -- the same
      permission joining the collaboration websocket itself needs (`controllers/collab.ts`).
    */
    {
      schema: {
        summary: "Claim the right to seed a collaboration room's WYSIWYG field",
        description:
          "At most one caller is ever granted this, cluster-wide, for a given room's lifetime -- see `core/collab.ts#claimWysiwygSeed` for the coordination and OpenProject #2516 for why the WYSIWYG (TipTap) editor needs it where the markdown editor does not: unlike the markdown field, the shared `Y.XmlFragment` TipTap binds to has no server-side seed of its own, so two people opening a brand new room's WYSIWYG editor at the same instant could otherwise both seed it from their own locally-loaded copy of the page and duplicate its content. This never sees the actual ProseMirror JSON either way -- only a boolean crosses here.\n\nNeeds `write:pages` on this page, the same permission joining the room itself needs.",
        tags: ['Pages'],
        params: { $ref: 'SitePageParams#' },
        response: {
          200: {
            description: "Whether this caller may seed the room's WYSIWYG field.",
            type: 'object',
            properties: {
              granted: { type: 'boolean' }
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
      const granted = await WIKI.collab.claimWysiwygSeed(page.id)
      return { granted }
    }
  )
}

export default routes
