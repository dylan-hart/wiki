import { mayOnPage } from '../api/pages.ts'
import { isValidUuid } from '../helpers/common.ts'

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { WebSocket } from 'ws'

/**
 * _collab Routes
 *
 * The websocket behind live collaborative editing. One socket per editor, one room per page — see
 * `core/collab.ts` for what a room is and how rooms find each other across instances.
 *
 * Unlike its neighbours under `controllers/`, nothing here is public. A room carries a page's unsaved
 * text and everyone's cursor, so joining one takes a session that may edit that page — the same
 * `write:pages` the save itself takes, checked against the page rather than against the group's
 * permission list. Whoever may only *suggest* edits does not qualify, which is what keeps a suggestion
 * the private draft it is meant to be.
 *
 * The handshake is the only place authorization happens: a socket is checked once, when it opens, and
 * a permission taken away mid-session takes effect the next time the editor is opened.
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
        Before the first `await`, and that is the point: the client starts talking as soon as the
        socket is open, which is well before the checks below have finished asking the database
        anything. See `capture` in `core/collab.ts`.
      */
      const session = WIKI.collab.capture(socket)

      /*
        Refusals terminate the socket outright rather than closing it. `close()` only starts the
        closing handshake — `ws` sends a close frame, marks the socket CLOSING, and arms a 30s timeout
        before actually tearing down the connection, all while `capture`'s message listener above is
        still installed and still live. A client is not obligated to honour that close frame, so
        `close()` here would hand an unauthenticated, unauthorized or otherwise refused caller up to 30
        more seconds of a socket it has already been told it may not use — exactly the grace window
        `capture`'s own pending-frame cap (`core/collab.ts`) exists to not need. `terminate()` drops the
        connection immediately instead, at the cost of the close code that would otherwise have told
        the browser "you may not edit this" versus "the connection dropped" (see `composables/collab.js`)
        — a real client sees an ordinary disconnect and may retry, and is refused again just as fast.
      */
      if (!isValidUuid(siteId) || !isValidUuid(pageId)) {
        return socket.terminate()
      }
      if (!req.session?.authenticated) {
        return socket.terminate()
      }
      if (!WIKI.sites[siteId]?.config?.features?.collaborativeEditing) {
        return socket.terminate()
      }

      const page = await WIKI.models.pages.getPage({ siteId, id: pageId })
      if (!page) {
        return socket.terminate()
      }
      if (!mayOnPage(req, 'write:pages', siteId, page)) {
        return socket.terminate()
      }

      await WIKI.collab.join(socket, { id: pageId, siteId }, session)
    }
  )
}

export default routes
