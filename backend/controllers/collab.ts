import { mayOnPage } from '../helpers/pageAccess.ts'
import { isValidUuid } from '../helpers/common.ts'

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { WebSocket } from 'ws'

/**
 * The websocket behind live collaborative editing: one socket per editor, one room per page (see
 * `core/collab.ts`).
 *
 * A room carries a page's unsaved text and everyone's cursor, so joining one takes `write:pages` on
 * that page, the same as the save itself. Whoever may only *suggest* edits does not qualify, which
 * keeps a suggestion the private draft it is meant to be.
 *
 * The handshake is the only place authorization happens: a permission taken away mid-session takes
 * effect the next time the editor is opened.
 */
async function routes(app: FastifyInstance) {
  app.get<{ Params: { siteId: string; pageId: string } }>(
    '/:siteId/:pageId',
    { websocket: true, schema: { hide: true } },
    async (
      socket: WebSocket,
      req: FastifyRequest<{ Params: { siteId: string; pageId: string } }>
    ) => {
      const { siteId, pageId } = req.params

      /*
        Must stay before the first `await`: the client starts talking as soon as the socket is open,
        well before the checks below have finished. See `capture` in `core/collab.ts`.
      */
      const session = CARDINAL.collab.capture(socket)

      /*
        Refusals close the socket rather than answering: the client is y-websocket, which speaks the
        sync protocol and nothing else. The codes are in the private 4000 range, which the browser
        hands to the page — how the editor (`composables/collab.js`) tells "you may not edit this"
        from a dropped connection and knows not to reconnect.

        `refuse()`, not `socket.close()`: a client that ignores the close frame would otherwise keep
        `capture()`'s pre-auth listener attached for `ws`'s 30s closing-handshake grace period.
      */
      if (!isValidUuid(siteId) || !isValidUuid(pageId)) {
        return CARDINAL.collab.refuse(socket, 4400, 'Invalid site or page id')
      }
      if (!req.session?.authenticated) {
        return CARDINAL.collab.refuse(socket, 4401, 'Authentication is required')
      }
      if (!CARDINAL.sites[siteId]?.config?.features?.collaborativeEditing) {
        return CARDINAL.collab.refuse(
          socket,
          4403,
          'Collaborative editing is disabled on this site'
        )
      }

      const page = await CARDINAL.models.pages.getPage({ siteId, id: pageId })
      if (!page) {
        return CARDINAL.collab.refuse(socket, 4404, 'This page does not exist')
      }
      if (!mayOnPage(req, 'write:pages', siteId, page)) {
        return CARDINAL.collab.refuse(socket, 4403, 'You are not allowed to edit this page')
      }

      await CARDINAL.collab.join(socket, { id: pageId, siteId }, session, {
        userId: req.session.user!.id,
        address: req.ip
      })
    }
  )
}

export default routes
