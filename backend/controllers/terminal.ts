import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { WebSocket } from 'ws'
import type { LogFrame } from '../core/logger.ts'

/**
 * _terminal Routes
 *
 * The websocket behind the admin area's live log view, which streams this instance's log records to
 * a browser as they are written. Read-only: nothing a client sends is looked at, and every frame
 * after the first is one `core/logger.ts` `LogFrame` as JSON — `{ timestamp, instance, level, scope,
 * message, fields, stack? }` — so the page filters by level and scope, colours by its own theme and
 * expands a stack on demand, rather than being handed this process's stdout formatting and its ANSI
 * escapes (OpenProject #2679). The first frame is the handshake below.
 *
 * Only this instance's own main thread is on that stream. Worker threads build their own logger
 * (`worker.ts`), and other instances write to their own consoles, so a clustered deployment shows the
 * terminal of whichever instance the socket happened to land on.
 *
 * Log lines quote paths, e-mail addresses and query failures, so the handshake takes `manage:system`
 * — the same permission as the rest of the system views, and never granted to a group by accident.
 */

/**
 * How much unsent traffic a client may accumulate before its stream starts skipping lines.
 *
 * A browser that has stopped reading — a backgrounded tab on a slow link, most likely — would
 * otherwise have the server hold every line since it stalled. Dropping is right here: the terminal is
 * a live view of what is happening now, not a transcript that has to be complete.
 */
const MAX_BUFFERED = 1048576 // 1mb

async function routes(app: FastifyInstance) {
  app.get(
    '/logs',
    { websocket: true, schema: { hide: true } },
    (socket: WebSocket, req: FastifyRequest) => {
      /*
        Refusals close the socket with a code in the private 4000 range, where the browser hands both
        code and reason to the page — which is how the terminal can print why it was turned away and
        know not to offer a reconnect. See `pages/AdminTerminal.vue`.
      */
      if (!req.session?.authenticated) {
        return socket.close(4401, 'Authentication is required')
      }
      if (!req.session.permissions?.includes('manage:system')) {
        return socket.close(4403, 'You are not allowed to read the server logs')
      }

      /*
        The id, never the e-mail address (OpenProject #2648): every line below goes to stdout, into the
        backlog, and from there to every admin terminal that connects afterwards, so an address
        written here is an address replayed to whoever reads the logs next. The id is how the rest of
        the codebase names an actor. Non-null because the `authenticated` check above has already
        run — a session that passed it always carries a user.
      */
      const userId = req.session.user!.id

      /*
        Logged before the listener is attached, so the record is already in the backlog by the time it
        is replayed below and the terminal opens on its own arrival. Every other connected terminal
        sees it live, which is the point: who is reading the logs is itself worth logging.
      */
      WIKI.logger.info('terminal', 'attached', { user: userId })

      const send = (frame: LogFrame) => {
        if (socket.readyState !== socket.OPEN || socket.bufferedAmount > MAX_BUFFERED) {
          return
        }
        socket.send(JSON.stringify(frame))
      }

      /*
        The handshake, and the only frame that is not a log record: which instance the client ended
        up talking to. Every `LogFrame` after it names the instance that wrote it, so this is
        strictly speaking redundant — but it is what tells the client which instance it is CONNECTED
        to before a single line has been written, on an idle server with an empty backlog. Sent
        before anything else, and unchanged in shape, so "the first frame" stays all the client has
        to know to find it.
      */
      socket.send(JSON.stringify({ instance: WIKI.INSTANCE_ID }))

      // -> A terminal that opens onto an idle server would otherwise sit empty and look broken
      for (const frame of WIKI.logger.backlog()) {
        send(frame)
      }

      WIKI.logger.ws.on('log', send)
      socket.on('close', () => {
        // -> Off the stream first, so this instance's own goodbye is not sent down a socket that is
        //    already closing
        WIKI.logger.ws.off('log', send)
        WIKI.logger.info('terminal', 'detached', { user: userId })
      })
    }
  )
}

export default routes
