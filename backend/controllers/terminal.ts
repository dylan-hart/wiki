import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { WebSocket } from 'ws'
import type { LogFrame } from '../core/logger.ts'

/**
 * The websocket behind the admin area's live log view. Read-only: nothing a client sends is looked
 * at, and every frame after the handshake is one `core/logger.ts` `LogFrame` as JSON, so the page
 * filters, colours and expands stacks itself rather than being handed this process's stdout
 * formatting and its ANSI escapes.
 *
 * Only this instance's own main thread is on that stream. Worker threads build their own logger
 * (`worker.ts`), and other instances write to their own consoles, so a clustered deployment shows the
 * terminal of whichever instance the socket happened to land on.
 *
 * Log lines quote paths and query failures, so the handshake takes `manage:system`.
 */

/**
 * How much unsent traffic a client may accumulate before its stream starts skipping lines. A browser
 * that has stopped reading would otherwise have the server hold every line since it stalled, and the
 * terminal is a live view, not a transcript that has to be complete.
 */
const MAX_BUFFERED = 1048576 // 1mb

async function routes(app: FastifyInstance) {
  app.get(
    '/logs',
    { websocket: true, schema: { hide: true } },
    (socket: WebSocket, req: FastifyRequest) => {
      /*
        Refusals close the socket with a code in the private 4000 range, where the browser hands both
        code and reason to the page — how the terminal (`pages/AdminLiveLog.vue`) prints why it was
        turned away and knows not to offer a reconnect.
      */
      if (!req.session?.authenticated) {
        return socket.close(4401, 'Authentication is required')
      }
      if (!req.session.permissions?.includes('manage:system')) {
        return socket.close(4403, 'You are not allowed to read the server logs')
      }

      /*
        The id, never the e-mail address: every line below goes to stdout, into the backlog, and from
        there to every admin terminal that connects afterwards. Non-null because a session that
        passed the `authenticated` check above always carries a user.
      */
      const userId = req.session.user!.id

      /*
        Logged before the listener is attached, so the record is already in the backlog replayed below
        and the terminal opens on its own arrival. Every other connected terminal sees it live: who
        is reading the logs is itself worth logging.
      */
      CARDINAL.logger.info('terminal', 'attached', { user: userId })

      const send = (frame: LogFrame) => {
        if (socket.readyState !== socket.OPEN || socket.bufferedAmount > MAX_BUFFERED) {
          return
        }
        socket.send(JSON.stringify(frame))
      }

      /*
        The handshake, and the only frame that is not a log record. Every `LogFrame` names its
        instance too, but this is what tells the client which instance it is connected to on an idle
        server with an empty backlog. Must stay the first frame: that is how the client finds it.
      */
      socket.send(JSON.stringify({ instance: CARDINAL.INSTANCE_ID }))

      // -> A terminal that opens onto an idle server would otherwise sit empty and look broken
      for (const frame of CARDINAL.logger.backlog()) {
        send(frame)
      }

      CARDINAL.logger.ws.on('log', send)
      socket.on('close', () => {
        // -> Off the stream first, so this instance's own goodbye is not sent down a socket that is
        //    already closing
        CARDINAL.logger.ws.off('log', send)
        CARDINAL.logger.info('terminal', 'detached', { user: userId })
      })
    }
  )
}

export default routes
