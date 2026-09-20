import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import { isSameOriginWebSocketHandshake } from '../helpers/common.ts'
import terminalRoutes from '../controllers/terminal.ts'
import collabRoutes from '../controllers/collab.ts'
import { installTestWiki } from './mocks.ts'

/**
 * The `verifyClient` cross-origin gate on the single `@fastify/websocket` registration in
 * `index.ts`.
 *
 * A WebSocket handshake is not subject to the same-origin policy and is not preflighted, so CORS
 * governs neither the handshake nor the frames that follow — unlike a form POST, the response is
 * fully readable by whichever origin opened the socket. `controllers/terminal.ts` and
 * `controllers/collab.ts` both authorize purely from `req.session`, which a foreign page's handshake
 * carries exactly as a same-origin one does, so the gate has to sit in front of both rather than in
 * either one.
 *
 * This reproduces `index.ts`'s registration shape rather than unit-testing
 * `isSameOriginWebSocketHandshake` in isolation (`helpers/common.test.ts` already does that): what a
 * pure-function test cannot show is that the real `ws` library calls `verifyClient` before either
 * route's handler ever runs.
 */
describe('WebSocket verifyClient (OpenProject #2120)', () => {
  let app: FastifyInstance
  let wikiHandle: { restore(): void }

  /**
   * `app.injectWS()`'s synthetic upgrade request carries no `socket` property at all, but `ws`'s own
   * `verifyClient` wiring unconditionally reads `req.socket.authorized`/`.encrypted` to build
   * `info.secure` — which throws `TypeError: Cannot read properties of undefined (reading
   * 'authorized')` the instant a `verifyClient` is registered at all. A real upgrade always has a
   * socket, so this only ever bites a harness built on `injectWS`. `upgradeContext` is spread onto
   * the fake request before its fixed properties, so supplying `socket` here is enough.
   */
  const NON_TLS_SOCKET = { authorized: false, encrypted: false } as any

  before(async () => {
    wikiHandle = installTestWiki({
      collab: {
        // -> Called before `controllers/collab.ts` checks anything else; nothing exercised here
        //    reads the session it returns.
        capture: () => ({}),
        // -> Every refusal branch in controllers/collab.ts goes through CARDINAL.collab.refuse
        //    rather than conn.close(). Without a stub that call throws inside the handler, which
        //    @fastify/websocket does not turn into a close frame -- the socket is left open and this
        //    suite's untimed `ws.once('close', ...)` wait hangs forever.
        refuse: (
          conn: { close: (code: number, reason: string) => void },
          code: number,
          reason: string
        ) => conn.close(code, reason)
      }
    })

    app = fastify()

    // -> Both routes inherit this `verifyClient` by being registered underneath the one
    //    `fastifyWebsocket` registration, as they are in `index.ts`.
    await app.register(fastifyWebsocket, {
      options: {
        maxPayload: 5242880,
        verifyClient: (info: {
          origin: string
          secure: boolean
          req: import('node:http').IncomingMessage
        }) =>
          isSameOriginWebSocketHandshake(info.origin, info.req.headers.host, [
            'wiki.example.com',
            'second-site.example.com'
          ])
      }
    })
    await app.register(terminalRoutes, { prefix: '/_terminal' })
    await app.register(collabRoutes, { prefix: '/_collab' })
    await app.ready()
  })

  after(async () => {
    await app.close()
    wikiHandle.restore()
  })

  for (const [name, path] of [
    ['/_terminal/logs', '/_terminal/logs'],
    ['/_collab/:siteId/:pageId', '/_collab/not-a-uuid/not-a-uuid']
  ] as const) {
    describe(name, () => {
      test('a foreign Origin is rejected before the controller handler runs', async () => {
        /*
          `verifyClient` returning false makes `ws`'s own `Server.handleUpgrade()` write this 401
          directly onto the raw socket and never invoke the callback `@fastify/websocket` resolves
          into a call to the route's `wsHandler`. An HTTP-level 401 therefore proves the controller
          handler never started, not merely that the socket ended up closed: `terminal.ts` and
          `collab.ts` both close over an *open* connection (codes 4400/4401/4403/4404, never an HTTP
          status), so it is a shape neither can produce on its own.
        */
        await assert.rejects(
          () =>
            app.injectWS(path, {
              headers: { origin: 'https://evil.example.com', host: 'wiki.example.com' },
              socket: NON_TLS_SOCKET
            }),
          /Unexpected server response: 401/
        )
      })

      test('a same-origin handshake reaches the controller', async () => {
        const ws = await app.injectWS(path, {
          headers: { origin: 'https://wiki.example.com', host: 'wiki.example.com' },
          socket: NON_TLS_SOCKET
        })
        try {
          // -> Proven by each controller's own first check closing the socket for a reason that has
          //    nothing to do with origin — `terminal.ts`'s `req.session?.authenticated` (no session
          //    plugin is registered here, so always falsy), `collab.ts`'s `isValidUuid`.
          const [code] = await new Promise<[number, Buffer]>((resolve) => {
            ws.once('close', (code: number, reason: Buffer) => resolve([code, reason]))
          })
          assert.ok(
            code === 4401 || code === 4400,
            `expected a controller-issued close code (4401 or 4400), got ${code}`
          )
        } finally {
          ws.terminate()
        }
      })

      test('a handshake whose Origin is another site on this same instance is also accepted', async () => {
        // -> Accepted only because it is in the allowed-hostname list the real gate fills from
        //    `CARDINAL.sitesMappings`, not because it matches the `host` header.
        const ws = await app.injectWS(path, {
          headers: { origin: 'https://second-site.example.com', host: 'wiki.example.com' },
          socket: NON_TLS_SOCKET
        })
        ws.terminate()
      })
    })
  }
})
